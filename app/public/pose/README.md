# Pose Model

Only the final active character from `mayong43111/lights-camera-action` is bundled:
Quaternius Universal Animation Library Standard's original orange/purple mannequin.

- Upstream revision: `443cb517b424e1ecd4154963d29edbff0798caa7`.
- Model: `assets/characters/quaternius-original.glb`, 629,852 bytes.
- SHA-256: `15257f2763eefeef41f2c544d9093145350fa055a04ca4f9d0aaf3bcf4553e6e`.
- Official source: https://quaternius.com/packs/universalanimationlibrary.html
- Model and official animation samples: CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/
- The normalized rig follows upstream `src/mannequin.js` using Three.js and three-vrm.

The local pose library contains all 43 official Standard static animation samples from
upstream `assets/poses/library.json`, including `A_TPose`. Only entries attributed to
Quaternius, licensed CC0-1.0, and linked to source GLB SHA-256
`69591853d817488edaa8fd9bf8fc1d821eaeaf789f8627b3cd23b41c4ed67997`
are included. Every entry retains its original joints, category, source clip, sample
time, rotation and placement. Upstream authored yoga poses and other model libraries
are excluded. Placement heights use upstream's 3.2-unit body height, scaled to the
local 2-unit mannequin.

Direct joint rotation uses Three.js TransformControls; tapping a body part selects
the nearest editable joint. The editing markers and rotation controls are omitted
from the exported reference board.
No VRoid models, external textures, remote CDN scripts or animation playback are included.