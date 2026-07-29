import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as paths;

String normaliseLines(String source) => source.replaceAll('\r\n', '\n');

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

    final String source = normaliseLines(await workflow.readAsString());
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
    expect(
      RegExp(r'flutter pub get --enforce-lockfile').allMatches(source).length,
      3,
    );
    expect(
      RegExp(r'git diff --exit-code -- pubspec\.lock').allMatches(source).length,
      3,
    );
    expect(RegExp(r'--no-pub').allMatches(source).length, 5);
    expect(source, contains('git diff --exit-code --'));

    final File scaffold = File(
      paths.join(repositoryRoot, 'scripts', 'scaffold-flutter-spike.sh'),
    );
    final String scaffoldSource = normaliseLines(await scaffold.readAsString());
    expect(
      scaffoldSource,
      contains('mktemp -d "$repo_root/.flutter-spike-scaffold.XXXXXX"'),
    );
    expect(scaffoldSource, contains('if [ "$original_moved" -eq 1 ]'));
    expect(scaffoldSource, contains('mv "$backup_dir" "$spike_dir"'));
    expect(
      scaffoldSource.indexOf('flutter create'),
      lessThan(scaffoldSource.indexOf('mv "$spike_dir" "$backup_dir"')),
      reason: 'generation must finish before the committed spike is moved',
    );

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
