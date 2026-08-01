import {
  clampCompanionStage,
  HIGHEST_COMPANION_STAGE,
} from '../companion-stage-contract.js';
import { evolutionDecision, stageArtUrl } from './monster-stage-model.js';
import {
  glowPulse,
  shockwaveRing,
  spawnBurst,
  twinkleSparks,
} from './stage-fx.js';

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
      this.Phaser = Phaser;
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
      this.scheduleSway();
      this.schedulePreen();
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
      this.sprite.setPosition(width / 2, this.groundY).setScale(fit).setAngle(0);
      this.buildVignette(width, height);
      this.children.bringToTop(this.sprite);
      if (this.breath) this.startBreathing();
    }

    /** The one continuous idle: gentle breathe with a counter-squash, seated. */
    startBreathing() {
      this.breath?.stop();
      const scale = this.baseScale;
      this.sprite.setScale(scale).setAngle(0);
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
          .setAngle(0)
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

    /** Occasional soft lean — second idle variety, still LCG-timed. */
    scheduleSway() {
      this.time.delayedCall(12000 + this.rng() * 8000, () => this.sway());
    }

    sway() {
      const scale = this.baseScale;
      this.interrupt((done) => {
        this.tweens.chain({
          targets: this.sprite,
          tweens: [
            {
              scaleX: scale * 1.04,
              angle: 4,
              duration: 280,
              ease: 'Sine.Out',
            },
            {
              scaleX: scale * 0.98,
              angle: -3,
              duration: 320,
              ease: 'Sine.InOut',
            },
            {
              scaleX: scale,
              angle: 0,
              duration: 240,
              ease: 'Sine.InOut',
            },
          ],
          onComplete: done,
        });
      });
      this.scheduleSway();
    }

    /**
     * The rare one. A preen is the beat a child only catches if they linger:
     * a small settle-and-shine, with a few twinkles at the crown. Kept far
     * slower than the other idles so it stays a surprise, not a tic.
     */
    schedulePreen() {
      this.time.delayedCall(20000 + this.rng() * 15000, () => this.preen());
    }

    preen() {
      const scale = this.baseScale;
      this.interrupt((done) => {
        const bounds = this.sprite.getBounds();
        // Straddle the crown line rather than sit inside it: a 5px spark is
        // lost against painted plumage and crisp against the open vignette.
        twinkleSparks(this, {
          x: bounds.centerX,
          y: bounds.y + bounds.height * 0.03,
          count: 3,
          spreadX: bounds.width * 0.85,
          spreadY: bounds.height * 0.1,
          rng: () => this.rng(),
          depth: 3,
          duration: 560,
          stagger: 150,
        });
        this.tweens.chain({
          targets: this.sprite,
          tweens: [
            // Gather down, rise proud, settle — the shape of a small preen.
            {
              scaleY: scale * 0.95,
              scaleX: scale * 1.05,
              duration: 200,
              ease: 'Sine.Out',
            },
            {
              scaleY: scale * 1.05,
              scaleX: scale * 0.97,
              angle: 2.5,
              duration: 240,
              ease: 'Sine.InOut',
            },
            {
              scaleY: scale,
              scaleX: scale,
              angle: 0,
              duration: 280,
              ease: 'Sine.InOut',
            },
          ],
          onComplete: done,
        });
      });
      this.schedulePreen();
    }

    /** Tap: squash-and-stretch with an overshoot settle plus a soft burst. */
    react() {
      if (this.evolving) return;
      spawnBurst(this, {
        x: this.sprite.x,
        y: this.sprite.y - this.sprite.displayHeight * 0.5,
        count: 8,
        colours: TAP_COLOURS,
        rng: () => this.rng(),
      });
      const scale = this.baseScale;
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
      const centreY = y - old.displayHeight * 0.5;
      // The last evolution a companion will ever have earns the celebration
      // card's double-ring language, brought home to the Monster Stage.
      const finalForm = to >= HIGHEST_COMPANION_STAGE;

      glowPulse(this, this.Phaser, {
        x,
        y: centreY,
        radius: old.displayWidth * 0.5,
        colour: 0xe2a62b,
      });
      shockwaveRing(this, {
        x,
        y: centreY,
        colour: 0xe2a62b,
        startRadius: Math.max(14, old.displayWidth * 0.18),
        endScale: 4.8,
        duration: 620,
      });
      if (finalForm) {
        shockwaveRing(this, {
          x,
          y: centreY,
          colour: 0xe2a62b,
          startRadius: Math.max(10, old.displayWidth * 0.13),
          endScale: 6.4,
          duration: 1000,
          delay: 240,
          startAlpha: 0.42,
          lineWidth: 2,
        });
      }
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
      spawnBurst(this, {
        x,
        y: y - next.displayHeight * 0.5,
        count: 12,
        colours: REWARD_COLOURS,
        rng: () => this.rng(),
      });
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
          if (finalForm) {
            twinkleSparks(this, {
              x,
              y: y - next.displayHeight * 0.55,
              count: 5,
              colour: 0xe2a62b,
              spreadX: next.displayWidth * 1.2,
              spreadY: next.displayHeight * 0.8,
              rng: () => this.rng(),
              depth: 5,
              size: 6,
              duration: 620,
              stagger: 110,
            });
          }
        },
      });
    }
  })();
}
