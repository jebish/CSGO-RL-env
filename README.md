```bash
bash start.sh
```

 #**Placeholders needing improvements**
 - Weapon firing/usage/reload graphics (bullets, melee, flamethrower, ....)
 - User char graphics (requires blender 3d model inplace of .glb char)

 # **Tasks (Software)**
 - gradio as game server
 - lobbies logic via local login + hf creds
 - websocket distributed systems for PvP : re-use https://huggingface.co/spaces/1024m/HF_hackathon
 - account amnagement and logic system via hf spaces + local creds
 - GTA components for health, stats, utils, current weapon, ammo, ping
 
 # **Tasks (Features)**
- Accurate useful FOV logic
- Weapons firing audio
- Game timer and end logic
- Scope in/out, scope as a variable feature for weapons

 # **Tasks (AI/ML)**
 - RL data collector utils
 - Baseline reward policy
 - Game/payer stats collection