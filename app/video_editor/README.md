# Comfy Cut dependencies

Comfy Cut is served by ComfyUI at `/video-editor/`. Its timeline, media handling,
LTX 2.3 generation, DMD distillation profile, SAM3 masking, simple masks, and
two-stage inpainting use nodes bundled with this ComfyUI checkout. Do not install
a separate LTX custom-node pack for these features.

Two features have optional custom-node dependencies:

| Feature | Custom-node pack | Required nodes |
| --- | --- | --- |
| Krea 2 image edit | [ComfyUI-Krea2Edit](https://github.com/lbouaraba/comfyui-krea2edit) | `Krea2EditModelPatch`, `Krea2EditGroundedEncode` |
| EditAnything v1.1 | [ComfyUI-BFSNodes](https://github.com/alisson-anjos/ComfyUI-BFSNodes) | `LTXVEditAnythingLoopingSampler` |

Install both packs for the complete feature set:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/lbouaraba/comfyui-krea2edit
git clone https://github.com/alisson-anjos/ComfyUI-BFSNodes

cd ComfyUI-BFSNodes
pip install -r requirements.txt
```

Restart ComfyUI after installation. The Krea 2 and EditAnything model and LoRA
files are separate from their custom nodes and must be selected under
**Comfy Cut → Settings → Models**. Comfy Cut does not download models.
