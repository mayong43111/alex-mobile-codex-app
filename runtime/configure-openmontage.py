import ast
from pathlib import Path
import sys


class ManagedSpeechIdentity(ast.NodeTransformer):
    def __init__(self):
        self.credentials = 0
        self.headers = 0

    def visit_Call(self, node):
        if ast.unparse(node.func) == 'os.environ.get' and len(node.args) == 1 and isinstance(node.args[0], ast.Constant) and node.args[0].value == 'AZURE_SPEECH_KEY':
            self.credentials += 1
            return ast.copy_location(ast.parse("os.environ.get('AZURE_SPEECH_KEY') or os.environ.get('AZURE_SPEECH_TOKEN')", mode='eval').body, node)
        return self.generic_visit(node)

    def visit_Dict(self, node):
        self.generic_visit(node)
        for index, key in enumerate(node.keys):
            if isinstance(key, ast.Constant) and key.value == 'Ocp-Apim-Subscription-Key':
                self.headers += 1
                node.keys[index] = ast.parse("'Authorization' if os.environ.get('AZURE_SPEECH_TOKEN') else 'Ocp-Apim-Subscription-Key'", mode='eval').body
                node.values[index] = ast.IfExp(test=ast.parse("os.environ.get('AZURE_SPEECH_TOKEN')", mode='eval').body, body=ast.parse("'Bearer ' + os.environ['AZURE_SPEECH_TOKEN']", mode='eval').body, orelse=node.values[index])
        return node


def configure_azure_tts(source):
    adapter = ManagedSpeechIdentity()
    tree = adapter.visit(ast.parse(source))
    if (adapter.credentials, adapter.headers) != (2, 1):
        raise ValueError('Unexpected OpenMontage Azure TTS authentication contract')
    return ast.unparse(ast.fix_missing_locations(tree)) + '\n'


if __name__ == '__main__':
    path = Path(sys.argv[1])
    path.write_text(configure_azure_tts(path.read_text(encoding='utf-8')), encoding='utf-8')