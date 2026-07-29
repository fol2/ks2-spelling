import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as paths;

void main() {
  test('the retained platform gate is immutable, read-only and repository-owned', () async {
    final String repositoryRoot = Directory.current.parent.parent.path;
    final File workflow = File(
      paths.join(
        repositoryRoot,
        '.github',
        'workflows',
        'flutter-flame-spike.yml',
      ),
    );
    expect(await workflow.exists(), isTrue);

    final String source = (await workflow.readAsString()).replaceAll(
      '\r\n',
      '\n',
    );
    expect(
      source,
      contains('types: [opened, reopened, synchronize, ready_for_review]'),
    );
    expect(source, isNot(contains('edited')));
    expect(source, contains('permissions:\n  contents: read'));
    expect(source, isNot(contains('contents: write')));
    expect(
      RegExp(
        r'github\.event\.pull_request\.head\.repo\.full_name == github\.repository',
      ).allMatches(source).length,
      3,
    );
    expect(
      RegExp(
        r'ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\|\|',
      ).allMatches(source).length,
      3,
    );
    expect(
      source,
      contains(
        'FLUTTER_COMMIT: 84fc5cbb223bc12f83d65b647ff8a56caf779ffd',
      ),
    );
    expect(source, contains('flutter pub get --enforce-lockfile'));
    expect(source, contains('git diff --exit-code --'));

    final File temporaryHardening = File(
      paths.join(
        repositoryRoot,
        '.github',
        'workflows',
        'pr56-return-key-focus-hardening.yml',
      ),
    );
    expect(
      await temporaryHardening.exists(),
      isFalse,
      reason: 'one-use source-generating workflows must remove themselves',
    );
  });
}
