import base64
import io
import json
import sys
import av


def main():
    seconds = float(sys.argv[2])
    if not 0 <= seconds <= 600:
        raise ValueError('Invalid timestamp')
    with av.open(sys.argv[1], options={'protocol_whitelist': 'file'}) as container:
        stream = container.streams.video[0]
        stream.thread_type = 'NONE'
        if stream.codec_context.width * stream.codec_context.height > 40_000_000:
            raise ValueError('Frame too large')
        container.seek(int(seconds / stream.time_base), stream=stream, backward=True)
        for frame in container.decode(stream):
            timestamp = float(frame.time or 0)
            if timestamp + 0.05 < seconds:
                continue
            image = frame.to_image()
            image.thumbnail((1024, 1024))
            output = io.BytesIO()
            image.convert('RGB').save(output, format='JPEG', quality=80)
            print(json.dumps({'seconds': timestamp, 'data': base64.b64encode(output.getvalue()).decode('ascii')}))
            return
        raise ValueError('No frame at requested time')


if __name__ == '__main__':
    main()