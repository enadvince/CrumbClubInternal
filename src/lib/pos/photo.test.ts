import { describe, expect, it } from "vitest";
import { fitWithin } from "./photo";

describe("payment photo sizing", () => {
  it("shrinks large photos to 1280px on the long side, keeping the shape", () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1280, height: 960 });
    expect(fitWithin(3000, 4000)).toEqual({ width: 960, height: 1280 });
  });
  it("never enlarges small photos", () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });
});
