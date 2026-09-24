import json
from pathlib import Path
import subprocess
from uuid import UUID

import folder_paths


def prepare_workspace(source, target):
    target.mkdir()
    for entry in source.iterdir():
        if not entry.name.startswith('.'):
            (target / entry.name).symlink_to(entry, target_is_directory=entry.is_dir())
    return target


class StudioOpenMontageTalkingHead:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {'job_id': ('STRING', {'default': ''})}}

    RETURN_TYPES = ()
    FUNCTION = 'render'
    CATEGORY = 'studio/OpenMontage'
    OUTPUT_NODE = True

    def render(self, job_id):
        identifier = str(UUID(job_id))
        if identifier != job_id:
            raise ValueError('Invalid job ID')
        source = Path(folder_paths.get_input_directory()) / 'studio-avatar'
        image = source / f'{identifier}.png'
        audio = source / f'{identifier}.wav'
        if not image.is_file() or not audio.is_file() or image.is_symlink() or audio.is_symlink():
            raise ValueError('Missing project image or narration')
        plan = source / f'{identifier}.json'
        if plan.exists():
            if plan.is_symlink() or plan.stat().st_size > 65536:
                raise ValueError('Invalid narration plan')
            segments = json.loads(plan.read_text())['segments']
            if not 1 <= len(segments) <= 12:
                raise ValueError('Invalid segment count')
            for index in range(1, len(segments)):
                narration = source / f'{identifier}-{index + 1:02d}.wav'
                if not narration.is_file() or narration.is_symlink():
                    raise ValueError('Missing segment narration')
        directory = Path(folder_paths.get_output_directory()) / 'studio-avatar' / identifier
        directory.mkdir(parents=True, exist_ok=True)
        with (directory / 'submitted').open('x'):
            pass
        import comfy.model_management as management
        management.unload_all_models()
        management.soft_empty_cache()
        home = Path('/srv/openmontage-avatar')
        workspace = prepare_workspace(home / 'SadTalker', directory / 'sadtalker')
        environment = {
            'PATH': f'{home}/venv/bin:/usr/bin:/bin',
            'HOME': str(directory),
            'NUMBA_CACHE_DIR': str(directory / 'numba-cache'),
            'PYTHONPATH': str(home / 'openmontage'),
            'SADTALKER_PATH': str(workspace),
        }
        output = directory / 'video.mp4'
        command = [str(home / 'venv/bin/python'), str(home / 'openmontage-avatar-worker.py'), str(image), str(audio), str(output)]
        if plan.exists():
            command.append(str(plan))
        with (directory / 'worker.log').open('xb') as log:
            result = subprocess.run(command, cwd=home, env=environment, stdout=log, stderr=log, timeout=1800 if plan.exists() else 660, check=False)
        if result.returncode or not output.is_file():
            raise RuntimeError('OpenMontage job failed; original job remains recorded, no automatic retry')
        return {'ui': {'videos': [{'filename': output.name, 'subfolder': f'studio-avatar/{identifier}', 'type': 'output'}]}}


NODE_CLASS_MAPPINGS = {'StudioOpenMontageTalkingHead': StudioOpenMontageTalkingHead}
NODE_DISPLAY_NAME_MAPPINGS = {'StudioOpenMontageTalkingHead': 'OpenMontage Talking Head'}