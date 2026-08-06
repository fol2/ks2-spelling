import 'dart:ui';

import 'package:flame/game.dart';

final class CompanionEvolutionGame extends FlameGame {
  CompanionEvolutionGame({required this.evolved});

  final bool evolved;

  String get semanticsLabel => evolved
      ? 'Inklet companion, newly evolved'
      : 'Inklet egg, waiting to hatch';

  @override
  Color backgroundColor() => const Color(0x00000000);

  @override
  void render(Canvas canvas) {
    super.render(canvas);

    final double width = size.x > 0 ? size.x : 280;
    final double height = size.y > 0 ? size.y : 160;
    final Paint sky = Paint()..color = const Color(0xFFDDECD7);
    final Paint ground = Paint()..color = const Color(0xFF9DB57C);
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTWH(0, 0, width, height),
        const Radius.circular(22),
      ),
      sky,
    );
    canvas.drawRRect(
      RRect.fromRectAndCorners(
        Rect.fromLTWH(0, height * 0.66, width, height * 0.34),
        bottomLeft: const Radius.circular(22),
        bottomRight: const Radius.circular(22),
      ),
      ground,
    );

    final Offset centre = Offset(width / 2, height * 0.57);
    if (evolved) {
      _drawCompanion(canvas, centre);
    } else {
      _drawEgg(canvas, centre);
    }
  }

  void _drawEgg(Canvas canvas, Offset centre) {
    final Paint shadow = Paint()..color = const Color(0x33000000);
    final Paint shell = Paint()..color = const Color(0xFFF6E8C7);
    final Paint markings = Paint()..color = const Color(0xFF577A73);
    canvas.drawOval(
      Rect.fromCenter(
        center: Offset(centre.dx, centre.dy + 36),
        width: 92,
        height: 18,
      ),
      shadow,
    );
    canvas.drawOval(
      Rect.fromCenter(center: centre, width: 86, height: 112),
      shell,
    );
    canvas.drawCircle(Offset(centre.dx - 18, centre.dy - 8), 11, markings);
    canvas.drawCircle(Offset(centre.dx + 20, centre.dy + 18), 8, markings);
  }

  void _drawCompanion(Canvas canvas, Offset centre) {
    final Paint shadow = Paint()..color = const Color(0x33000000);
    final Paint body = Paint()..color = const Color(0xFF466C68);
    final Paint belly = Paint()..color = const Color(0xFFDDE9D6);
    final Paint eye = Paint()..color = const Color(0xFF172B31);
    final Paint highlight = Paint()..color = const Color(0xFFFDFCF6);

    canvas.drawOval(
      Rect.fromCenter(
        center: Offset(centre.dx, centre.dy + 42),
        width: 110,
        height: 20,
      ),
      shadow,
    );

    final Path leftEar = Path()
      ..moveTo(centre.dx - 42, centre.dy - 36)
      ..lineTo(centre.dx - 56, centre.dy - 78)
      ..lineTo(centre.dx - 15, centre.dy - 50)
      ..close();
    final Path rightEar = Path()
      ..moveTo(centre.dx + 42, centre.dy - 36)
      ..lineTo(centre.dx + 56, centre.dy - 78)
      ..lineTo(centre.dx + 15, centre.dy - 50)
      ..close();
    canvas.drawPath(leftEar, body);
    canvas.drawPath(rightEar, body);
    canvas.drawOval(
      Rect.fromCenter(center: centre, width: 108, height: 112),
      body,
    );
    canvas.drawOval(
      Rect.fromCenter(
        center: Offset(centre.dx, centre.dy + 22),
        width: 58,
        height: 54,
      ),
      belly,
    );
    for (final double direction in <double>[-1, 1]) {
      final Offset eyeCentre = Offset(centre.dx + (direction * 22), centre.dy - 18);
      canvas.drawCircle(eyeCentre, 9, eye);
      canvas.drawCircle(Offset(eyeCentre.dx - 2, eyeCentre.dy - 3), 3, highlight);
    }
    canvas.drawCircle(Offset(centre.dx, centre.dy + 2), 5, eye);
  }
}
