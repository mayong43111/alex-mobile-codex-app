import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class NativeAvatarTest(unittest.TestCase):
    def test_sequence_uses_exact_tail_sources_and_native_stitch(self):
        module = load('sequence_worker', 'openmontage-avatar-worker.py')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'image.png'
            source.write_bytes(b'original')
            audio = root / 'job.wav'
            audio.write_bytes(b'first-audio')
            second_audio = root / 'job-02.wav'
            second_audio.write_bytes(b'second-audio')
            plan = {'sourceAssetId': str(uuid4()), 'sourceHash': module.file_hash(source), 'segments': [
                {'text': 'First', 'continueFromPrevious': False, 'audioHash': module.file_hash(audio)},
                {'text': 'Second', 'continueFromPrevious': True, 'audioHash': module.file_hash(second_audio)},
            ]}
            plan_path = root / 'plan.json'
            plan_path.write_text(json.dumps(plan))
            sources = []
            def render(image, narration, output):
                progress = json.loads((root / 'manifest.json').read_text())
                self.assertEqual(progress['phase'], 'rendering')
                self.assertEqual(progress['segment'], len(sources) + 1)
                self.assertEqual(len(progress['segments']), len(sources))
                sources.append(Path(image))
                Path(output).write_bytes(b'clip-' + Path(narration).read_bytes())
            def sample(settings):
                self.assertEqual(settings['timestamps'], [0.08])
                target = Path(settings['output_dir'])
                target.mkdir()
                frame = target / 'frame.png'
                frame.write_bytes(b'exact-last-frame')
                return Mock(success=True, data={'frames': [{'path': str(frame)}]})
            def stitch(settings):
                self.assertEqual(json.loads((root / 'manifest.json').read_text())['phase'], 'stitching')
                self.assertEqual(settings['operation'], 'stitch')
                self.assertEqual(settings['transition'], 'cut')
                self.assertEqual(len(settings['clips']), 2)
                Path(settings['output_path']).write_bytes(b'complete')
                return Mock(success=True)
            with patch.object(module, 'render', side_effect=render), patch.object(module, 'last_frame_timestamp', return_value=0.08), patch.object(module, 'FrameSampler') as sampler, patch.object(module, 'VideoStitch') as stitcher:
                sampler.return_value.execute.side_effect = sample
                stitcher.return_value.execute.side_effect = stitch
                module.render_sequence(source, audio, root / 'video.mp4', plan_path)
            manifest = json.loads((root / 'manifest.json').read_text())
            self.assertEqual(sources, [source, root / 'segment-01/tail.png'])
            self.assertEqual(manifest['status'], 'completed')
            self.assertEqual(manifest['segments'][1]['clip']['sourceAssetId'], manifest['segments'][0]['tail']['id'])
            self.assertEqual(manifest['segments'][1]['clip']['sourceHash'], manifest['segments'][0]['tail']['hash'])
            self.assertEqual(source.read_bytes(), b'original')

    def test_sequence_stop_retains_finished_segments_and_skips_remaining_work(self):
        module = load('stoppable_worker', 'openmontage-avatar-worker.py')
        for stop_after in (0, 1, 2):
            with self.subTest(stop_after=stop_after), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = root / 'image.png'
                source.write_bytes(b'original')
                segments = []
                for index in range(2):
                    audio = root / ('job.wav' if index == 0 else 'job-02.wav')
                    audio.write_bytes(b'audio')
                    segments.append({'text': 'Narration', 'continueFromPrevious': index > 0, 'audioHash': module.file_hash(audio)})
                plan_path = root / 'job.json'
                plan_path.write_text(json.dumps({'sourceAssetId': str(uuid4()), 'sourceHash': module.file_hash(source), 'segments': segments}))
                marker = plan_path.with_suffix('.stop')
                if stop_after == 0:
                    marker.touch()
                completed = []
                def render(image, narration, output):
                    Path(output).write_bytes(b'clip')
                    completed.append(output)
                    if len(completed) == stop_after:
                        marker.touch()
                def sample(settings):
                    frame = Path(settings['output_dir']).with_name('frame.png')
                    frame.write_bytes(b'tail')
                    return Mock(success=True, data={'frames': [{'path': str(frame)}]})
                with patch.object(module, 'render', side_effect=render), patch.object(module, 'last_frame_timestamp', return_value=0.08), patch.object(module, 'FrameSampler') as sampler, patch.object(module, 'VideoStitch') as stitcher:
                    sampler.return_value.execute.side_effect = sample
                    result = module.render_sequence(source, root / 'job.wav', root / 'video.mp4', plan_path)
                    stitcher.assert_not_called()
                manifest = json.loads((root / 'manifest.json').read_text())
                self.assertTrue(result['stopped'])
                self.assertEqual(manifest['status'], 'cancelled')
                self.assertEqual(manifest['phase'], 'stopped')
                self.assertEqual(len(manifest['segments']), stop_after)
                self.assertEqual(len(completed), stop_after)
                self.assertFalse((root / 'video.mp4').exists())

    def test_worker_delegates_to_openmontage(self):
        module = load('native_worker', 'openmontage-avatar-worker.py')
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'image.png'
            source.touch()
            audio = Path(directory) / 'audio.wav'
            audio.touch()
            with patch.object(module, 'TalkingHead') as factory, patch.object(module, 'VideoTrimmer') as converter:
                factory.return_value.execute.return_value = Mock(success=True)
                converter.return_value.execute.return_value = Mock(success=True)
                self.assertTrue(module.render(source, audio, Path(directory) / 'video.mp4')['success'])
                settings = factory.return_value.execute.call_args.args[0]
                self.assertEqual(settings['model'], 'sadtalker')
                self.assertEqual(settings['preprocess'], 'full')
                self.assertTrue(settings['still_mode'])
                self.assertEqual(settings['output_path'], str(Path(directory) / 'native.mp4'))
                conversion = converter.return_value.execute.call_args.args[0]
                self.assertEqual(conversion['codec'], 'libx264')
                self.assertEqual(conversion['start_seconds'], 0)
                self.assertNotIn('end_seconds', conversion)
                factory.return_value.execute.return_value = Mock(success=False, error='native diagnostic')
                diagnostic = io.StringIO()
                with patch.object(sys, 'stderr', diagnostic), self.assertRaises(RuntimeError):
                    module.render(source, audio, Path(directory) / 'video.mp4')
                self.assertIn('native diagnostic', diagnostic.getvalue())
                self.assertEqual(factory.return_value.execute.call_count, 2)
                converter.return_value.execute.assert_called_once()

    def test_node_uses_existing_queue_and_blocks_duplicate_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = types.ModuleType('folder_paths')
            paths.get_input_directory = lambda: str(root / 'input')
            paths.get_output_directory = lambda: str(root / 'output')
            management = types.ModuleType('comfy.model_management')
            management.unload_all_models = Mock()
            management.soft_empty_cache = Mock()
            comfy = types.ModuleType('comfy')
            comfy.model_management = management
            with patch.dict(sys.modules, {'folder_paths': paths, 'comfy': comfy, 'comfy.model_management': management}):
                module = load('native_node', 'openmontage-avatar-node.py')
                native = root / 'native'
                native.mkdir()
                (native / 'inference.py').write_text('native-source')
                (native / 'checkpoints').mkdir()
                (native / '.git').mkdir()
                workspace = module.prepare_workspace(native, root / 'workspace')
                self.assertEqual((workspace / 'inference.py').read_text(), 'native-source')
                self.assertTrue((workspace / 'checkpoints').is_symlink())
                self.assertFalse((workspace / '.git').exists())
                (workspace / 'temporary.mp4').write_bytes(b'temporary')
                self.assertFalse((native / 'temporary.mp4').exists())
                node = module.StudioOpenMontageTalkingHead()
                with self.assertRaises(ValueError):
                    node.render('../invalid')
                identifier = str(uuid4())
                source = root / 'input/studio-avatar'
                source.mkdir(parents=True)
                (source / f'{identifier}.png').touch()
                (source / f'{identifier}.wav').touch()
                def finish(command, **options):
                    Path(command[-1]).write_bytes(b'test-video')
                    self.assertNotIn('AZURE_SPEECH_TOKEN', options['env'])
                    self.assertEqual(options['env']['HOME'], str(root / 'output/studio-avatar' / identifier))
                    self.assertEqual(options['env']['NUMBA_CACHE_DIR'], str(root / 'output/studio-avatar' / identifier / 'numba-cache'))
                    self.assertEqual(options['env']['SADTALKER_PATH'], str(workspace))
                    return Mock(returncode=0)
                with patch.object(module, 'prepare_workspace', return_value=workspace), patch.object(module.subprocess, 'run', side_effect=finish) as worker:
                    result = node.render(identifier)
                    self.assertEqual(result['ui']['videos'][0]['subfolder'], f'studio-avatar/{identifier}')
                    with self.assertRaises(FileExistsError):
                        node.render(identifier)
                    worker.assert_called_once()
                management.unload_all_models.assert_called_once()


if __name__ == '__main__':
    unittest.main()