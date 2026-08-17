/**
 * Types for the parts of `tools/icons.mjs` that the test suite reads.
 *
 * The generator stays plain JavaScript because `tools/` is run directly rather
 * than typechecked with the platform. But `tests/pwa.test.ts` imports the device
 * list from it so that the launch images, the media queries in the shell and the
 * assertions cannot drift apart — and importing an untyped module under `strict`
 * is an error. Declaring the two exported symbols is the fix; suppressing the
 * error would have been the other one.
 */

export type IosLaunchTarget = {
  /** Device pixel width and height — what the PNG must be, exactly. */
  w: number;
  h: number;
  /** CSS pixel width and height — what the media query matches on. */
  cssW: number;
  cssH: number;
  ratio: number;
};

export declare const IOS_LAUNCH: IosLaunchTarget[];

export declare function launchImageName(entry: IosLaunchTarget): string;
