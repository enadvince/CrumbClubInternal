import { describe, expect, it } from "vitest";
import { fitWithin, PRODUCT_PHOTO_MAX_SIDE } from "./photo";

describe("payment photo sizing", () => {
  it("shrinks large photos to 1280px on the long side, keeping the shape", () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1280, height: 960 });
    expect(fitWithin(3000, 4000)).toEqual({ width: 960, height: 1280 });
  });
  it("shrinks product photos further", () => {
    expect(fitWithin(4032, 3024, PRODUCT_PHOTO_MAX_SIDE)).toEqual({ width: 640, height: 480 });
  });
  it("never enlarges small photos", () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });
});
