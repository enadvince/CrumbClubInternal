import { describe, expect, it } from "vitest";
import { extractReference } from "./ocrReference";

describe("extractReference", () => {
  it("reads a GCash reference with its spacing, stopping at the date", () => {
    const text = "Sent via GCash\nAmount 120.00\nTotal Amount Sent ₱120.00\nRef No. 5012 345 678901 Oct 13, 2026 2:15 PM";
    expect(extractReference(text)).toBe("5012345678901");
  });

  it("reads a reference on the line after its label", () => {
    expect(extractReference("Reference No.\n1023 456 789012\nOct 13, 2026")).toBe("1023456789012");
  });

  it("reads alphanumeric Maya and bank references", () => {
    expect(extractReference("Payment successful\nReference ID: A1B2C3D4E5F6\nDate Oct 13")).toBe("A1B2C3D4E5F6");
    expect(extractReference("InstaPay\nTrace No. 123456\nAmount PHP 250.00")).toBe("123456");
  });

  it("fixes letters OCR confuses with digits inside the number", () => {
    expect(extractReference("Ref No. 5O12 345 67B9O1")).toBe("5012345678901");
  });

  it("falls back to a single unlabelled 13 digit number, ignoring phone numbers", () => {
    expect(extractReference("GCash\n+63 917 123 4567\n09171234567\n5012 345 678901\n₱120.00")).toBe("5012345678901");
  });

  it("returns null when it can't tell", () => {
    expect(extractReference("Thank you!\n₱120.00")).toBeNull();
    expect(extractReference("1111 222 333444\n5555 666 777888")).toBeNull();
    expect(extractReference("Ref No. pending")).toBeNull();
    expect(extractReference("")).toBeNull();
  });
});
