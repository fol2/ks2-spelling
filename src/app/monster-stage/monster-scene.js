import { clampCompanionStage } from '../companion-stage-contract.js';
import { evolutionDecision, stageArtUrl } from './monster-stage-model.js';

/**
 * The Monster Stage scene: procedural life on static art. A factory that takes
 * Phaser (so this module has no static phaser import — phaser stays in its own
 * dynamic chunk). All motion is tween-based; the one continuous idle is the
 * breathing tween, paused around each transient beat and resumed from base so
 * scale/position tweens never fight.
 */

// Palette lifted from the design tokens (--brand, --warn, --bad, --panel).
// Canvas cannot read CSS variables, so these track app.css by hand.
const TAP_COLOURS = [0x3e6fa8, 0xd08a2c, 0xd25757];
const REWARD_COLOURS = [0xd08a2c, 0x3e6fa8, 0xffffff];

// Eye anchors per stage as fractions of the sprite's on-screen box (x from
// left, y from top). Stage 0 is the egg — no face, so no blink. Decorative and
// forgiving: a brief dark lid near the eyes reads as a blink even if a hair off.
const EYES = {
  1: { r: 0.05, pts: [[0.31, 0.41], [0.46, 0.41]] },
  2: { r: 0.05, pts: [[0.29, 0.32], [0.45, 0.33]] },
  3: { r: 0.045, pts: [[0.36, 0.30], [0.50, 0.30]] },
  4: { r: 0.038, pts: [[0.44, 0.29], [0.54, 0.29]] },
};

const stageKey = (stage) => `monster-${clampCompanionStage(stage)}`;

// Deterministic pseudo-random (LCG) seeded from secureCount, so blink/hop
// cadence is stable per progress state rather than Math.random noise.
function makeRng(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function createMonsterScene(Phaser, props) {
  return new (class MonsterScene extends Phaser.Scene {
    constructor() {
      super('monster');
      this.props = props;
      this.stage = clampCompanionStage(props.stage);
    }

    preload() {
      this.load.image(
        stageKey(this.props.stage),
        stageArtUrl(
          this.props.monsterId,
          this.props.branch,
          this.props.stage,
        ),
      );
    }

    create() {
      this.rng = makeRng((this.props.secureCount | 0) + 1);
      const { width, height } = this.scale.gameSize;

      this.sprite = this.add
        .image(0, 0, stageKey(this.props.stage))
        .setOrigin(0.5, 1);
      this.layout(width, height);

      this.startBreathing();
      this.scheduleBlink();
      this.scheduleHop();
      this.startMotes();

      this.sprite.setInteractive({ useHandCursor: false });
      this.sprite.on('pointerdown', () => this.react());
      this.scale.on('resize', (size) => this.layout(size.width, size.height));
      // Re-seed cadence when progress updates arrive via the registry.
      this.registry.events.on('changedata-secureCount', (_parent, value) => {
        this.rng = makeRng((value | 0) + 1);
      });

      this.props.onReady?.();
    }

    /** Soft paper-tone radial glow behind the creature — drawn, no asset. */
    buildVignette(width, height) {
      this.vignette?.destroy();
      const graphics = this.add.graphics().setDepth(-1);
      const centreX = width / 2;
      const centreY = height * 0.58;
      const maximumRadius = Math.max(width, height) * 0.62;
      // Many overlapping rings, faintest first, accumulate into a smooth centre.
      for (let index = 24; index > 0; index -= 1) {
        graphics.fillStyle(0xfffdf7, 0.03);
        graphics.fillCircle(
          centreX,
          centreY,
          (maximumRadius * index) / 24,
        );
      }
      this.vignette = graphics;
    }

    /** Seat the creature on the floor line and fit it to the stage. */
    layout(width, height) {
      this.groundY = height * 0.92;
      const fit = Math.min(
        (width * 0.74) / this.sprite.width,
        (height * 0.82) / this.sprite.height,
      );
      this.baseScale = fit;
      this.sprite.setPosition(width / 2, this.groundY).setScale(fit);
      this.buildVignette(width, height);
      this.children.bringToTop(this.sprite);
      if (this.breath) this.startBreathing();
    }

    /** The one continuous idle: gentle breathe with a counter-squash, seated. */
    startBreathing() {
      this.breath?.stop();
      const scale = this.baseScale;
      this.sprite.setScale(scale);
      this.breath = this.tweens.add({
        targets: this.sprite,
        scaleY: scale * 1.03,
        scaleX: scale * 0.99,
        duration: 1400,
        ease: 'Sine.InOut',
        yoyo: true,
        repeat: -1,
      });
    }

    /** Pause the idle, run a transient beat, then settle back to base. */
    interrupt(build) {
      if (this.busy || this.evolving) return;
      this.busy = true;
      this.breath?.pause();
      build(() => {
        this.sprite
          .setScale(this.baseScale)
          .setPosition(this.sprite.x, this.groundY);
        this.busy = false;
        this.startBreathing();
      });
    }

    scheduleBlink() {
      this.time.delayedCall(3000 + this.rng() * 4000, () => this.blink());
    }

    blink() {
      const eyes = EYES[this.stage];
      if (eyes) {
        const bounds = this.sprite.getBounds();
        for (const [pointX, pointY] of eyes.pts) {
          const lid = this.add
            .ellipse(
              bounds.x + pointX * bounds.width,
              bounds.y + pointY * bounds.height,
              eyes.r * bounds.width * 2,
              eyes.r * bounds.width * 2.4,
              0x11253a,
              0.9,
            )
            .setDepth(3)
            .setScale(1, 0);
          this.tweens.add({
            targets: lid,
            scaleY: 1,
            duration: 70,
            yoyo: true,
            hold: 20,
            ease: 'Sine.InOut',
            onComplete: () => lid.destroy(),
          });
        }
      }
      this.scheduleBlink();
    }

    scheduleHop() {
      this.time.delayedCall(9000 + this.rng() * 6000, () => this.hop());
    }

    hop() {
      const scale = this.baseScale;
      const up = this.groundY - this.scale.height * 0.04;
      this.interrupt((done) => {
        this.tweens.chain({
          targets: this.sprite,
          tweens: [
            { y: up, duration: 220, ease: 'Sine.Out' },
            { y: this.groundY, duration: 200, ease: 'Sine.In' },
            {
              scaleY: scale * 0.94,
              scaleX: scale * 1.04,
              duration: 90,
              ease: 'Sine.Out',
            },
            {
              scaleY: scale,
              scaleX: scale,
              duration: 120,
              ease: 'Sine.InOut',
            },
          ],
          onComplete: done,
        });
      });
      this.scheduleHop();
    }

    /** Tap: squash-and-stretch with an overshoot settle plus a soft burst. */
    react() {
      if (this.evolving) return;
      const scale = this.baseScale;
      this.spawnBurst(
        this.sprite.x,
        this.sprite.y - this.sprite.displayHeight * 0.5,
        8,
        TAP_COLOURS,
      );
      this.interrupt((done) => {
        this.tweens.chain({
          targets: this.sprite,
          tweens: [
            {
              scaleX: scale * 1.12,
              scaleY: scale * 0.9,
              duration: 110,
              ease: 'Sine.Out',
            },
            {
              scaleX: scale * 0.94,
              scaleY: scale * 1.08,
              duration: 120,
              ease: 'Sine.InOut',
            },
            {
              scaleX: scale,
              scaleY: scale,
              duration: 150,
              ease: 'Back.Out',
            },
          ],
          onComplete: done,
        });
      });
    }

    spawnBurst(x, y, count, colours) {
      for (let index = 0; index < count; index += 1) {
        const circle = this.add
          .circle(
            x + (this.rng() * 40 - 20),
            y + (this.rng() * 20 - 10),
            3 + this.rng() * 3,
            colours[(this.rng() * colours.length) | 0],
            0.9,
          )
          .setDepth(4);
        this.tweens.add({
          targets: circle,
          y: circle.y - 40 - this.rng() * 40,
          alpha: 0,
          scale: 0.4,
          duration: 600 + this.rng() * 300,
          ease: 'Sine.Out',
          onComplete: () => circle.destroy(),
        });
      }
    }

    /** 3–4 slow motes drifting up over the vignette; self-cleaning, calm. */
    startMotes() {
      const spawn = () => {
        const width = this.scale.width;
        const height = this.scale.height;
        // Behind the creature (above the vignette) so it reads as calm depth.
        const mote = this.add
          .circle(
            this.rng() * width,
            height * 0.98,
            2 + this.rng() * 2,
            0xffffff,
            0.28,
          )
          .setDepth(-0.5);
        this.tweens.add({
          targets: mote,
          y: height * 0.12,
          x: mote.x + (this.rng() * 40 - 20),
          alpha: 0,
          duration: 6000 + this.rng() * 3000,
          ease: 'Sine.InOut',
          onComplete: () => mote.destroy(),
        });
      };
      spawn();
      spawn();
      this.time.addEvent({ delay: 2400, loop: true, callback: spawn });
    }

    /** Public: called by the island when the stage prop increases while mounted. */
    playEvolution(from, to) {
      const decision = evolutionDecision(from, to);
      if (decision.kind !== 'evolve' || this.evolving) return;
      this.evolving = true;
      const key = stageKey(decision.to);
      const run = () => this.runEvolution(decision.to, key);
      if (this.textures.exists(key)) {
        run();
      } else {
        this.load.image(
          key,
          stageArtUrl(
            this.props.monsterId,
            this.props.branch,
            decision.to,
          ),
        );
        this.load.once('complete', run);
        this.load.start();
      }
    }

    runEvolution(to, key) {
      this.breath?.pause();
      const { width, height } = this.scale.gameSize;
      const x = this.sprite.x;
      const y = this.groundY;
      const old = this.sprite;

      const glow = this.add
        .circle(
          x,
          y - old.displayHeight * 0.5,
          old.displayWidth * 0.5,
          0xe2a62b,
          0,
        )
        .setDepth(1)
        .setBlendMode(Phaser.BlendModes.ADD);
      this.tweens.add({
        targets: glow,
        alpha: 0.5,
        scale: 1.4,
        duration: 500,
        yoyo: true,
        ease: 'Sine.InOut',
        onComplete: () => glow.destroy(),
      });
      this.tweens.add({
        targets: old,
        scale: this.baseScale * 0.6,
        alpha: 0,
        duration: 500,
        ease: 'Sine.In',
        onComplete: () => old.destroy(),
      });

      const next = this.add.image(x, y, key).setOrigin(0.5, 1);
      const nextScale = Math.min(
        (width * 0.74) / next.width,
        (height * 0.82) / next.height,
      );
      next.setScale(nextScale * 0.6).setAlpha(0);
      this.spawnBurst(
        x,
        y - next.displayHeight * 0.5,
        12,
        REWARD_COLOURS,
      );
      this.tweens.add({
        targets: next,
        scaleX: nextScale,
        scaleY: nextScale,
        alpha: 1,
        duration: 700,
        delay: 300,
        ease: 'Back.Out',
        onComplete: () => {
          next.setInteractive({ useHandCursor: false });
          next.on('pointerdown', () => this.react());
          this.sprite = next;
          this.stage = to;
          this.baseScale = nextScale;
          this.evolving = false;
          this.startBreathing();
        },
      });
    }
  })();
}
