import json
import hashlib
from datetime import datetime, timezone
from pathlib import Path
import shutil
import subprocess
import sys
from uuid import uuid4

from tools.analysis.frame_sampler import FrameSampler
from tools.avatar.talking_head import TalkingHead
from tools.video.video_stitch import VideoStitch
from tools.video.video_trimmer import VideoTrimmer


def render(image, audio, output):
    destination = Path(output).resolve()
    original = destination.with_name('native.mp4')
    result = TalkingHead().execute({
        'image_path': str(Path(image).resolve(strict=True)),
        'audio_path': str(Path(audio).resolve(strict=True)),
        'output_path': str(original),
        'model': 'sadtalker',
        'still_mode': True,
        'preprocess': 'full',
    })
    if not result.success:
        print(json.dumps({'tool': 'talking_head', 'error': str(result.error)[:16000]}), file=sys.stderr, flush=True)
        raise RuntimeError('OpenMontage talking_head failed; inspect the existing job, do not resubmit')
    converted = VideoTrimmer().execute({
        'operation': 'cut',
        'input_path': str(original),
        'output_path': str(destination),
        'start_seconds': 0,
        'codec': 'libx264',
    })
    if not converted.success:
        print(json.dumps({'tool': 'video_trimmer', 'error': str(converted.error)[:16000]}), file=sys.stderr, flush=True)
        raise RuntimeError('OpenMontage normalization failed; original video retained')
    return {'success': True, 'tool': 'talking_head', 'model': 'sadtalker'}


def last_frame_timestamp(video):
    result = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', str(video)], capture_output=True, text=True, check=True, timeout=30)
    frames = json.loads(result.stdout)['frames']
    return float(frames[-1]['best_effort_timestamp_time'])


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save_manifest(path, manifest):
    manifest['updatedAt'] = datetime.now(timezone.utc).isoformat()
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(manifest), encoding='utf-8')
    temporary.replace(path)


def render_sequence(image, audio, output, plan_path):
    plan = json.loads(Path(plan_path).read_text())
    segments = plan['segments']
    if not 1 <= len(segments) <= 12 or segments[0]['continueFromPrevious']:
        raise ValueError('Invalid sequence')
    destination = Path(output).resolve()
    manifest_path = destination.parent / 'manifest.json'
    manifest = {'segments': [], 'status': 'running', 'phase': 'queued', 'segment': 0}
    stop_path = Path(plan_path).with_suffix('.stop')
    def stopped():
        if not stop_path.exists():
            return False
        manifest.update(status='cancelled', phase='stopped')
        save_manifest(manifest_path, manifest)
        return True
    save_manifest(manifest_path, manifest)
    source_path = Path(image).resolve(strict=True)
    source_id, source_hash = plan['sourceAssetId'], plan['sourceHash']
    clips = []
    for index, segment in enumerate(segments):
        if stopped():
            return {'success': False, 'stopped': True, 'segments': len(clips)}
        if not segment['continueFromPrevious']:
            source_path = Path(image).resolve(strict=True)
            source_id, source_hash = plan['sourceAssetId'], plan['sourceHash']
        directory = destination.parent / f'segment-{index + 1:02d}'
        directory.mkdir()
        clip_path = directory / 'video.mp4'
        audio_path = Path(audio) if index == 0 else Path(audio).with_name(f'{Path(audio).stem}-{index + 1:02d}.wav')
        if audio_path.is_symlink() or file_hash(audio_path) != segment['audioHash']:
            raise ValueError('Invalid narration bytes')
        manifest.update(phase='rendering', segment=index + 1)
        save_manifest(manifest_path, manifest)
        render(source_path, audio_path, clip_path)
        clip_id = str(uuid4())
        clip_hash = file_hash(clip_path)
        timestamp = last_frame_timestamp(clip_path)
        manifest['phase'] = 'tail'
        save_manifest(manifest_path, manifest)
        sampled = FrameSampler().execute({'input_path': str(clip_path), 'strategy': 'timestamps', 'timestamps': [timestamp], 'format': 'png', 'output_dir': str(directory / 'frames')})
        if not sampled.success or len(sampled.data.get('frames', [])) != 1:
            raise RuntimeError(f'OpenMontage tail frame failed: {sampled.error}')
        tail_path = directory / 'tail.png'
        shutil.move(sampled.data['frames'][0]['path'], tail_path)
        tail_id, tail_hash = str(uuid4()), file_hash(tail_path)
        manifest['segments'].append({'text': segment['text'], 'continueFromPrevious': segment['continueFromPrevious'], 'clip': {'id': clip_id, 'hash': clip_hash, 'sourceAssetId': source_id, 'sourceHash': source_hash}, 'tail': {'id': tail_id, 'hash': tail_hash, 'sourceAssetId': clip_id, 'sourceHash': clip_hash, 'seconds': timestamp}})
        save_manifest(manifest_path, manifest)
        source_path, source_id, source_hash = tail_path, tail_id, tail_hash
        clips.append(str(clip_path))
    if stopped():
        return {'success': False, 'stopped': True, 'segments': len(clips)}
    manifest['phase'] = 'stitching'
    save_manifest(manifest_path, manifest)
    if len(clips) == 1:
        shutil.copyfile(clips[0], destination)
    else:
        stitched = VideoStitch().execute({'operation': 'stitch', 'clips': clips, 'output_path': str(destination), 'transition': 'cut', 'auto_normalize': True, 'codec': 'libx264'})
        if not stitched.success:
            raise RuntimeError(f'OpenMontage stitch failed: {stitched.error}')
    manifest['status'] = 'completed'
    manifest['phase'] = 'completed'
    manifest['hash'] = file_hash(destination)
    save_manifest(manifest_path, manifest)
    return {'success': True, 'tool': 'talking_head', 'segments': len(clips)}


if __name__ == '__main__':
    print(json.dumps(render_sequence(*sys.argv[1:]) if len(sys.argv) == 5 else render(*sys.argv[1:])))