// The original's movie player (`movie_play` 0x00408800, RE docs/formats/
// movies.md) in the browser: one <video> over everything, on the 640 x 480
// stage the front end uses, at the rectangle the caller pushes, stretched to
// it as DirectShow's video window stretches. Raw DOM, outside the frame loop
// (nothing here runs per frame; ui.md §1), shared by the menu and main.ts.
//
// What it keeps from the original:
//   - 200 ms after the call the UI sound is cut (Sleep(200), PlaySoundA(NULL),
//     0x0040881c / 0x0040882d), then the movie starts on a black screen
//     (`video_clear(0)` after Run, 0x00408a72);
//   - the Movies slider's volume: level 0 silent, else
//     -(10000 - 10000 * level / 127) / 6 hundredths of a dB (0x00408a09..);
//   - played once, never looped (EC_COMPLETE tears it down, 0x00408714);
//   - Space skips (0x0045a666); with the front end up any mouse button, down
//     or up, skips and reaches nothing else (0x0040bbe2), with it down a left
//     press does (0x0045a85e).
// What it adds, the browser's: a movie that is not there (offline, a 404),
// that this browser cannot decode (AV1 without a decoder: Safari before
// A17 Pro / M3) or that errors mid-way ends as "unavailable", and the caller
// does what it did before the import. A browser that refuses to start it with
// sound (autoplay policy) gets it muted rather than not at all.

import { FE_MOVIE_BASE, FE_MOVIES } from "./movies.generated";
import { stageScale, stageStyle } from "./stage";

/** How a movie ended: its last frame, a skip, or never shown. */
export type MovieEnd = "ended" | "skipped" | "unavailable";

/** A rectangle on the 640 x 480 screen, as `movie_play` takes it. */
export interface MovieBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The boot's, the way out's, the film strip's and frame_step_game's: (0, 0x29) 0x280 x 0x18e. */
export const MOVIE_BOX_FULL: MovieBox = { left: 0, top: 0x29, width: 0x280, height: 0x18e };

/** HELP's and BRIEFING's: (0x40, 0x1e) 0x200 x 0x120, four pixels left under FullScreen. */
export function movieBoxHelp(fullScreen: boolean): MovieBox {
  return { left: fullScreen ? 0x3c : 0x40, top: 0x1e, width: 0x200, height: 0x120 };
}

/** `movie_play`'s put_Volume argument in hundredths of a dB (0x00408a09..0x00408a53). */
export function movieCentibels(level: number): number {
  const l = Math.max(0, Math.min(127, Math.trunc(level)));
  if (l === 0) return -10000;
  const attenuation = 10000 - Math.trunc((10000 * l) / 127);
  return -Math.trunc(attenuation / 6) | 0; // | 0: an integer, never -0
}

/** That level as a <video> volume, 0..1. */
export function movieGain(level: number): number {
  const cb = movieCentibels(level);
  return cb <= -10000 ? 0 : 10 ** (cb / 2000);
}

/** The movie's URL and MIME type, or null when the build has none of that name. */
export function movieSource(name: string): { url: string; type: string } | null {
  const m = FE_MOVIES[name];
  return m ? { url: `${FE_MOVIE_BASE}${m.file}`, type: m.type } : null;
}

export interface MovieOptions {
  /** The Movies slider, 0..127. */
  level: number;
  /** Whether the front end is up: then any mouse button skips, else only the left. */
  frontEnd: boolean;
  /** The caller cleared the screen before the call (the film strip, the boot). */
  clearFirst?: boolean;
  /** PlaySoundA(NULL): cut the UI sound 200 ms in. */
  stopUiSound?: () => void;
}

export interface MoviePlayback {
  readonly done: Promise<MovieEnd>;
  /** movie_stop: as a skip. */
  stop(): void;
}

/** The delay `movie_play` sleeps before it cuts the UI sound and starts (0x0040881c). */
export const MOVIE_START_DELAY_MS = 200;

/** Plays `name` (the original's file name, e.g. "multibrf.mpg") in `box`. */
export function playMovie(name: string, box: MovieBox, opts: MovieOptions): MoviePlayback {
  let finish: (end: MovieEnd) => void = () => {};
  const done = new Promise<MovieEnd>((resolve) => {
    finish = resolve;
  });
  const src = movieSource(name);
  const probe = document.createElement("video");
  if (!src || probe.canPlayType(src.type) === "") {
    finish("unavailable");
    return { done, stop: () => {} };
  }

  const root = document.createElement("div");
  root.className = "fe-movie";
  root.dataset.movie = name;
  const stage = document.createElement("div");
  stage.className = "fe-movie-stage";
  const video = probe;
  video.className = "fe-movie-video";
  video.playsInline = true;
  video.preload = "auto";
  video.style.cssText = `left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px`;
  video.volume = movieGain(opts.level);
  video.muted = video.volume === 0;
  stage.appendChild(video);
  root.appendChild(stage);
  const fit = (): void => {
    stage.style.cssText = stageStyle(stageScale(innerWidth, innerHeight));
  };
  fit();
  if (opts.clearFirst) root.classList.add("is-playing");
  document.body.appendChild(root);

  let over = false;
  let timer = 0;
  const end = (how: MovieEnd): void => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    removeEventListener("keydown", onKey, true);
    removeEventListener("pointerdown", onButton, true);
    removeEventListener("pointerup", onButton, true);
    removeEventListener("resize", fit);
    video.pause();
    video.removeAttribute("src");
    video.load();
    root.remove();
    finish(how);
  };
  const onKey = (e: KeyboardEvent): void => {
    // The movie is asked before the key (0x0045a65d): every key stops here.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === " " || e.code === "Space") end("skipped");
  };
  const onButton = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (opts.frontEnd || (e.type === "pointerdown" && e.button === 0)) end("skipped");
  };
  addEventListener("keydown", onKey, true);
  addEventListener("resize", fit);
  video.addEventListener("ended", () => end("ended"));
  video.addEventListener("error", () => end("unavailable"));

  // Sleep(200), PlaySoundA(NULL), then Run on a cleared screen.
  timer = setTimeout(() => {
    if (over) return;
    opts.stopUiSound?.();
    // The click that started it has been released by now: from here a
    // button is a skip.
    addEventListener("pointerdown", onButton, true);
    addEventListener("pointerup", onButton, true);
    root.classList.add("is-playing");
    video.src = src.url;
    video.play().catch((err: unknown) => {
      if (over) return;
      if ((err as { name?: string })?.name === "NotAllowedError" && !video.muted) {
        video.muted = true;
        video.play().catch(() => end("unavailable"));
        return;
      }
      end("unavailable");
    });
  }, MOVIE_START_DELAY_MS) as unknown as number;

  return { done, stop: () => end("skipped") };
}
