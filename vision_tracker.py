#!/usr/bin/env python3
"""
Auxiliary frame-change tracker for hermes-live-video.

A fixed random-projection sketch: a patch-embedding plus sixteen attention/MLP
blocks, 768 dimensions wide, drawn once from a seeded generator and quantised to
int8. It downloads nothing and needs no model file. The seed is fixed so every
host and every restart produces the same feature space, which is what makes the
distance thresholds below mean the same thing each run.

Its only job is to answer "has the scene changed enough to be worth looking at?"
The semantic judgement — what is in the frame, whether the thing the user asked
about has appeared — belongs to the vision model in server.js. A random
projection preserves rough similarity (Johnson-Lindenstrauss), so a cosine
distance here is a cheap, honest change signal rather than a semantic embedding.

Reads base64 JPEG lines from stdin, writes one JSON object per frame to stdout.
"""
import sys, json, time, io, base64
from PIL import Image
import numpy as np
import torch
import torch.nn as nn
from torch.ao.quantization import quantize_dynamic

# Suppress warnings
import warnings
warnings.filterwarnings('ignore')

torch.set_grad_enabled(False)
torch.set_num_threads(2)  # Lean background worker to preserve host capacity

# Fixed seed: the sketch must be identical on every host and every restart,
# otherwise the thresholds below describe a different feature space each run.
SKETCH_SEED = 1729

class SketchMLP(nn.Module):
    def __init__(self, hidden_size=768, intermediate_size=3072):
        super().__init__()
        self.gate_proj = nn.Linear(hidden_size, intermediate_size, bias=False)
        self.up_proj = nn.Linear(hidden_size, intermediate_size, bias=False)
        self.down_proj = nn.Linear(intermediate_size, hidden_size, bias=False)
        self.act_fn = nn.GELU(approximate='tanh')
    def forward(self, x):
        return self.down_proj(self.act_fn(self.gate_proj(x)) * self.up_proj(x))

class SketchAttention(nn.Module):
    def __init__(self, hidden_size=768, num_heads=12):
        super().__init__()
        self.num_heads = num_heads
        self.head_dim = hidden_size // num_heads
        self.q_proj = nn.Linear(hidden_size, hidden_size, bias=False)
        self.k_proj = nn.Linear(hidden_size, hidden_size, bias=False)
        self.v_proj = nn.Linear(hidden_size, hidden_size, bias=False)
        self.out_proj = nn.Linear(hidden_size, hidden_size, bias=False)
    def forward(self, x):
        B, N, C = x.shape
        q = self.q_proj(x).view(B, N, self.num_heads, self.head_dim).transpose(1, 2)
        k = self.k_proj(x).view(B, N, self.num_heads, self.head_dim).transpose(1, 2)
        v = self.v_proj(x).view(B, N, self.num_heads, self.head_dim).transpose(1, 2)
        attn = torch.nn.functional.scaled_dot_product_attention(q, k, v)
        out = attn.transpose(1, 2).reshape(B, N, C)
        return self.out_proj(out)

class SketchBlock(nn.Module):
    def __init__(self, hidden_size=768, intermediate_size=3072, num_heads=12):
        super().__init__()
        self.input_layernorm = nn.RMSNorm(hidden_size, eps=1e-6)
        self.self_attn = SketchAttention(hidden_size, num_heads)
        self.post_attention_layernorm = nn.RMSNorm(hidden_size, eps=1e-6)
        self.mlp = SketchMLP(hidden_size, intermediate_size)
    def forward(self, x):
        x = x + self.self_attn(self.input_layernorm(x))
        x = x + self.mlp(self.post_attention_layernorm(x))
        return x

class RandomProjectionSketch(nn.Module):
    def __init__(self):
        super().__init__()
        self.patch_embed = nn.Conv2d(3, 768, kernel_size=16, stride=16, bias=False)
        self.layers = nn.ModuleList([SketchBlock() for _ in range(16)])
        self.post_layernorm = nn.RMSNorm(768, eps=1e-6)
    def forward(self, pixel_values):
        patches = self.patch_embed(pixel_values)
        B, C, H, W = patches.shape
        x = patches.flatten(2).transpose(1, 2)
        for layer in self.layers:
            x = layer(x)
        return self.post_layernorm(x).mean(dim=1)  # Global pooled sketch (1, 768)

# Initialise from the fixed seed, then quantise. No weights are loaded: this is
# a random projection by design, not a pre-trained tower wearing its name.
torch.manual_seed(SKETCH_SEED)
base_model = RandomProjectionSketch().eval()
qmodel = quantize_dynamic(base_model, {nn.Linear}, dtype=torch.qint8)

def preprocess_image(b64_data):
    raw_bytes = base64.b64decode(b64_data)
    img = Image.open(io.BytesIO(raw_bytes)).convert('RGB')
    img = img.resize((224, 224), Image.BILINEAR)
    arr = np.array(img, dtype=np.float32) / 255.0
    tensor = torch.from_numpy(arr).permute(2, 0, 1)
    mean = torch.tensor([0.485, 0.456, 0.406]).view(3, 1, 1)
    std = torch.tensor([0.229, 0.224, 0.225]).view(3, 1, 1)
    tensor = (tensor - mean) / std
    return tensor.unsqueeze(0)

# --- Anchor-frame drift model -------------------------------------------------
# Distance is measured against a stable reference ("anchor") frame rather than
# the immediately preceding frame. A purely pairwise delta is blind to slow
# re-entry: an object returning over several frames changes each individual
# step by less than the threshold, so no event ever fires. Drift against an
# anchor accumulates across the whole interval and therefore sees the arrival.
ANCHOR_MAJOR_THRESHOLD = 0.35      # large scene change, short refractory
ANCHOR_MODERATE_THRESHOLD = 0.22   # noticeable change, longer refractory
MAJOR_COOLDOWN_SECONDS = 4.0       # longer than one continuous hand sweep
MODERATE_COOLDOWN_SECONDS = 6.0
STABLE_DISTANCE = 0.06             # below this the scene is considered settled
ANCHOR_BLEND = 0.02                # slow adaptation while the scene is settled

# --- Already-described scene suppression --------------------------------------
# Re-anchoring after an event means a small drift back towards a scene described
# moments ago produces a second event for the same view. Keep the embeddings of
# recently described scenes and suppress an event whose frame lands on one of
# them, so one scene is described once per short window rather than per glance.
RECENT_SCENE_WINDOW_SECONDS = 30.0
RECENT_SCENE_DISTANCE = 0.10       # frame within this of a described scene = same view
MAX_RECENT_SCENES = 8              # older scenes expire: a genuine return still fires


def main():
    sys.stderr.write('[vision-tracker] Fixed-seed random-projection sketch initialised (anchor-frame drift model).\n')
    sys.stderr.flush()
    
    anchor_embedding = None
    prev_embedding = None
    frame_count = 0
    last_event_time = 0
    recent_scenes = []  # [(timestamp, embedding)] of scenes already described
    
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            if msg.get('type') != 'frame' or not msg.get('data'):
                continue
            
            t0 = time.perf_counter()
            img_tensor = preprocess_image(msg['data'])
            emb = qmodel(img_tensor)
            emb = emb / emb.norm(p=2, dim=-1, keepdim=True)
            latency_ms = (time.perf_counter() - t0) * 1000.0
            frame_count += 1
            
            distance = 0.0
            frame_distance = 0.0
            is_significant_change = False
            is_suppressed = False
            
            # Pairwise delta, retained for diagnostics only
            if prev_embedding is not None:
                frame_distance = max(0.0, 1.0 - (emb * prev_embedding).sum().item())
            
            if anchor_embedding is None:
                anchor_embedding = emb
            else:
                # Drift against the settled reference scene
                distance = max(0.0, 1.0 - (emb * anchor_embedding).sum().item())
                
                now = time.time()
                # Dynamic hysteresis on anchor drift:
                # Major change (>= 0.35): 4.0s refractory, longer than one hand sweep
                # Moderate change (>= 0.22): 6.0s refractory
                candidate = (
                    (distance >= ANCHOR_MAJOR_THRESHOLD and (now - last_event_time) > MAJOR_COOLDOWN_SECONDS)
                    or (distance >= ANCHOR_MODERATE_THRESHOLD and (now - last_event_time) > MODERATE_COOLDOWN_SECONDS)
                )

                is_suppressed = False
                if candidate:
                    # Forget scenes described long enough ago that a return to one
                    # is genuine news rather than a glance back
                    recent_scenes[:] = [s for s in recent_scenes if (now - s[0]) <= RECENT_SCENE_WINDOW_SECONDS]
                    is_suppressed = any(
                        1.0 - float((emb * seen).sum().item()) <= RECENT_SCENE_DISTANCE
                        for _, seen in recent_scenes
                    )

                if candidate and not is_suppressed:
                    is_significant_change = True
                    last_event_time = now
                    recent_scenes.append((now, emb))
                    if len(recent_scenes) > MAX_RECENT_SCENES:
                        del recent_scenes[0]
                    # Acknowledge the new scene: it becomes the reference
                    anchor_embedding = emb
                elif is_suppressed:
                    # A view already described: adopt it as the reference without
                    # raising an event, and leave the refractory untouched so a
                    # genuine change afterwards is not delayed
                    anchor_embedding = emb
                elif distance < STABLE_DISTANCE:
                    # Settled frame: nudge the anchor slowly so gradual lighting
                    # drift is absorbed instead of accumulating into a false event
                    anchor_embedding = anchor_embedding * (1.0 - ANCHOR_BLEND) + emb * ANCHOR_BLEND
                    anchor_embedding = anchor_embedding / anchor_embedding.norm(p=2, dim=-1, keepdim=True)
            
            prev_embedding = emb
            
            result = {
                'event': 'frame_processed',
                'frame_index': frame_count,
                'latency_ms': round(latency_ms, 1),
                'distance': round(distance, 4),
                'frame_distance': round(frame_distance, 4),
                'significant_change': is_significant_change,
                'suppressed': is_suppressed
            }
            print(json.dumps(result))
            sys.stdout.flush()
        except Exception as e:
            sys.stderr.write(f'[vision-tracker] Error: {e}\n')
            sys.stderr.flush()

if __name__ == '__main__':
    main()
