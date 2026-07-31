import { clampCompanionStage } from '../companion-stage-contract.js';
import { monsterCelebrationArtUrl } from './celebration-model.js';
import { glowPulse, shockwaveRing, spawnBurst } from '../monster-stage/stage-fx.js';

/**
 * Celebration Stage scene: a short painterly flourish over catch/evolution art.
 * Factory takes Phaser so this module never statically imports it — the phaser
 * chunk stays shared with MonsterStage. The DOM timer owns the queue clock;
 * every tween here finishes inside celebrationDurationMs and never extends it.
 */

const TEXTURE_KEY = 'celebration-art';

function makeRng(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function hashSeed(key) {
  let hash = 2166136261;
  const text = String(key || 'celebration');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function parseHex(hex, fallback = 0xffffff) {
  if (typeof hex !== 'string') return fallback;
  const cleaned = hex.trim().replace(/^#/u, '');
  const expanded = cleaned.length === 3
    ? cleaned.split('').map((ch) => ch + ch).join('')
    : cleaned;
  if (!/^[0-9a-fA-F]{6}$/u.test(expanded)) return fallback;
  return Number.parseInt(expanded, 16);
}

export function createCelebrationScene(Phaser, props) {
  return new (class CelebrationScene extends Phaser.Scene {
    constructor() {
      super('celebration');
      this.props = props;
      this.Phaser = Phaser;
    }

    preload() {
      const url = monsterCelebrationArtUrl(
        this.props.monsterId,
        this.props.branch,
        this.props.stage,
      );
      if (url) this.load.image(TEXTURE_KEY, url);
    }

    create() {
      this.rng = makeRng(hashSeed(this.props.eventKey) + (this.props.stage | 0) + 1);
      const { width, height } = this.scale.gameSize;
      const accent = parseHex(this.props.accent, 0x3e6fa8);
      const secondary = parseHex(this.props.secondary, 0x9fc1e8);
      this.palette = [accent, secondary, 0xffffff];

      this.groundY = height * 0.9;
      this.sprite = this.add.image(width / 2, this.groundY, TEXTURE_KEY)
        .setOrigin(0.5, 1);
      const fit = Math.min(
        (width * 0.72) / this.sprite.width,
        (height * 0.78) / this.sprite.height,
      );
      this.baseScale = fit;
      this.sprite.setScale(fit);

      this.scale.on('resize', (size) => this.layout(size.width, size.height));

      if (this.props.kind === 'caught') {
        this.playCaught();
      } else if (this.props.kind === 'evolve') {
        this.playEvolve();
      } else {
        this.startBreathing();
      }

      this.props.onReady?.();
    }

    layout(width, height) {
      if (!this.sprite?.active) return;
      this.groundY = height * 0.9;
      const fit = Math.min(
        (width * 0.72) / this.sprite.width,
        (height * 0.78) / this.sprite.height,
      );
      this.baseScale = fit;
      this.sprite.setPosition(width / 2, this.groundY).setScale(fit);
      if (this.breath) this.startBreathing();
    }

    startBreathing() {
      this.breath?.stop();
      const scale = this.baseScale;
      this.sprite.setScale(scale);
      this.breath = this.tweens.add({
        targets: this.sprite,
        scaleY: scale * 1.028,
        scaleX: scale * 0.99,
        duration: 1300,
        ease: 'Sine.InOut',
        yoyo: true,
        repeat: -1,
      });
    }

    /** Soft fill burst behind the creature — painted rings, no asset. */
    softRadialBurst(x, y, colour) {
      const graphics = this.add.graphics().setDepth(0).setAlpha(0);
      for (let index = 10; index > 0; index -= 1) {
        graphics.fillStyle(colour, 0.045);
        graphics.fillCircle(x, y, (Math.max(this.sprite.displayWidth, 80) * index) / 10);
      }
      this.tweens.add({
        targets: graphics,
        alpha: 1,
        duration: 280,
        yoyo: true,
        hold: 120,
        ease: 'Sine.Out',
        onComplete: () => graphics.destroy(),
      });
    }

    playCaught() {
      const scale = this.baseScale;
      const riseFrom = this.groundY + this.scale.height * 0.22;
      this.sprite.setPosition(this.sprite.x, riseFrom).setAlpha(0).setScale(scale * 0.92);

      this.tweens.add({
        targets: this.sprite,
        y: this.groundY,
        alpha: 1,
        scaleX: scale,
        scaleY: scale,
        duration: 780,
        ease: 'Cubic.Out',
        onComplete: () => {
          const centreY = this.groundY - this.sprite.displayHeight * 0.45;
          this.softRadialBurst(this.sprite.x, centreY, this.palette[0]);
          spawnBurst(this, {
            x: this.sprite.x,
            y: centreY,
            count: 10,
            colours: this.palette,
            rng: () => this.rng(),
            driftY: 36,
          });
          this.startBreathing();
        },
      });
    }

    playEvolve() {
      const scale = this.baseScale;
      const centreY = this.groundY - this.sprite.displayHeight * 0.45;
      this.sprite.setScale(scale * 0.55).setAlpha(0.15);

      glowPulse(this, this.Phaser, {
        x: this.sprite.x,
        y: centreY,
        radius: this.sprite.displayWidth * 0.55,
        colour: this.palette[0],
        peakAlpha: 0.55,
        scaleTo: 1.55,
        duration: 520,
      });

      spawnBurst(this, {
        x: this.sprite.x,
        y: centreY,
        count: 16,
        colours: this.palette,
        rng: () => this.rng(),
        driftY: 48,
        durationBase: 700,
      });

      const stage = clampCompanionStage(this.props.stage);
      shockwaveRing(this, {
        x: this.sprite.x,
        y: centreY,
        colour: this.palette[1],
        startRadius: Math.max(12, this.sprite.displayWidth * 0.16),
        endScale: 5.2,
        duration: 720,
      });
      if (stage >= 4) {
        shockwaveRing(this, {
          x: this.sprite.x,
          y: centreY,
          colour: this.palette[0],
          startRadius: Math.max(10, this.sprite.displayWidth * 0.12),
          endScale: 6.4,
          duration: 1100,
          delay: 180,
          startAlpha: 0.45,
          lineWidth: 2,
        });
      }

      this.tweens.add({
        targets: this.sprite,
        scaleX: scale,
        scaleY: scale,
        alpha: 1,
        duration: 820,
        delay: 160,
        ease: 'Back.Out',
        onComplete: () => {
          this.startShimmer();
          this.startBreathing();
        },
      });
    }

    /** Brief shimmer motes for evolution — a handful, then they stop. */
    startShimmer() {
      const budget = Math.min(2200, Math.max(900, (this.props.durationMs | 0) - 1200));
      const startedAt = this.time.now;
      const spawn = () => {
        if (this.time.now - startedAt > budget) return;
        const mote = this.add
          .circle(
            this.sprite.x + (this.rng() * this.sprite.displayWidth - this.sprite.displayWidth / 2),
            this.groundY - this.sprite.displayHeight * (0.2 + this.rng() * 0.6),
            1.5 + this.rng() * 2,
            this.palette[(this.rng() * this.palette.length) | 0],
            0.85,
          )
          .setDepth(5)
          .setBlendMode(this.Phaser.BlendModes.ADD);
        this.tweens.add({
          targets: mote,
          y: mote.y - (20 + this.rng() * 30),
          x: mote.x + (this.rng() * 24 - 12),
          alpha: 0,
          duration: 700 + this.rng() * 400,
          ease: 'Sine.Out',
          onComplete: () => mote.destroy(),
        });
        if (this.time.now - startedAt < budget) {
          this.time.delayedCall(140 + this.rng() * 160, spawn);
        }
      };
      spawn();
    }
  })();
}
