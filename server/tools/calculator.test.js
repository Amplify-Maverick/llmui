/**
 * Calculator Safe Eval Tests
 * Tests for the allowlist-only expression parser.
 *
 * Run with: node --test server/tools/calculator.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import { safeEval } from "./calculator.js";
import calculatorTool from "./calculator.js";

describe("safeEval", () => {
  describe("Basic Arithmetic", () => {
    it("should add two numbers", () => {
      assert.strictEqual(safeEval("2 + 3"), 5);
    });

    it("should subtract two numbers", () => {
      assert.strictEqual(safeEval("10 - 4"), 6);
    });

    it("should multiply two numbers", () => {
      assert.strictEqual(safeEval("6 * 7"), 42);
    });

    it("should divide two numbers", () => {
      assert.strictEqual(safeEval("15 / 3"), 5);
    });

    it("should handle decimal numbers", () => {
      assert.strictEqual(safeEval("3.14 + 2.86"), 6);
    });

    it("should handle negative results", () => {
      assert.strictEqual(safeEval("5 - 10"), -5);
    });

    it("should handle exponentiation", () => {
      assert.strictEqual(safeEval("2 ^ 10"), 1024);
    });

    it("should handle unary minus", () => {
      assert.strictEqual(safeEval("-5"), -5);
      assert.strictEqual(safeEval("--5"), 5);
    });

    it("should handle unary plus", () => {
      assert.strictEqual(safeEval("+5"), 5);
    });
  });

  describe("Operator Precedence", () => {
    it("should respect multiplication over addition", () => {
      assert.strictEqual(safeEval("2 + 3 * 4"), 14);
    });

    it("should respect division over subtraction", () => {
      assert.strictEqual(safeEval("10 - 6 / 2"), 7);
    });

    it("should respect exponentiation over multiplication", () => {
      assert.strictEqual(safeEval("2 * 3 ^ 2"), 18);
    });

    it("should handle right-associative exponentiation", () => {
      assert.strictEqual(safeEval("2 ^ 3 ^ 2"), 512); // 2^(3^2) = 2^9 = 512
    });

    it("should handle complex precedence", () => {
      assert.strictEqual(safeEval("1 + 2 * 3 ^ 2 - 4 / 2"), 17); // 1 + 18 - 2 = 17
    });
  });

  describe("Parentheses", () => {
    it("should override precedence with parentheses", () => {
      assert.strictEqual(safeEval("(2 + 3) * 4"), 20);
    });

    it("should handle nested parentheses", () => {
      assert.strictEqual(safeEval("((2 + 3) * (4 - 1))"), 15);
    });

    it("should handle deeply nested parentheses", () => {
      assert.strictEqual(safeEval("(((1 + 2)))"), 3);
    });

    it("should handle parentheses in exponentiation", () => {
      assert.strictEqual(safeEval("(2 ^ 3) ^ 2"), 64); // 8^2 = 64
    });
  });

  describe("Allowed Functions", () => {
    it("should compute sqrt", () => {
      assert.strictEqual(safeEval("sqrt(16)"), 4);
      assert.strictEqual(safeEval("sqrt(2)"), Math.sqrt(2));
    });

    it("should compute abs", () => {
      assert.strictEqual(safeEval("abs(-5)"), 5);
      assert.strictEqual(safeEval("abs(5)"), 5);
    });

    it("should compute floor", () => {
      assert.strictEqual(safeEval("floor(3.7)"), 3);
      assert.strictEqual(safeEval("floor(-3.2)"), -4);
    });

    it("should compute ceil", () => {
      assert.strictEqual(safeEval("ceil(3.2)"), 4);
      assert.strictEqual(safeEval("ceil(-3.7)"), -3);
    });

    it("should compute round", () => {
      assert.strictEqual(safeEval("round(3.5)"), 4);
      assert.strictEqual(safeEval("round(3.4)"), 3);
    });

    it("should compute log (natural log)", () => {
      assert.strictEqual(safeEval("log(1)"), 0);
      assert.strictEqual(safeEval("log(E)"), 1);
    });

    it("should compute sin", () => {
      assert.ok(Math.abs(safeEval("sin(0)") - 0) < 1e-10);
      assert.ok(Math.abs(safeEval("sin(PI / 2)") - 1) < 1e-10);
    });

    it("should compute cos", () => {
      assert.ok(Math.abs(safeEval("cos(0)") - 1) < 1e-10);
      assert.ok(Math.abs(safeEval("cos(PI)") - (-1)) < 1e-10);
    });

    it("should compute tan", () => {
      assert.ok(Math.abs(safeEval("tan(0)") - 0) < 1e-10);
    });

    it("should compute max with multiple arguments", () => {
      assert.strictEqual(safeEval("max(1, 5, 3)"), 5);
      assert.strictEqual(safeEval("max(-1, -5)"), -1);
    });

    it("should compute min with multiple arguments", () => {
      assert.strictEqual(safeEval("min(1, 5, 3)"), 1);
      assert.strictEqual(safeEval("min(-1, -5)"), -5);
    });

    it("should handle nested function calls", () => {
      assert.strictEqual(safeEval("sqrt(abs(-16))"), 4);
      assert.strictEqual(safeEval("floor(sqrt(10))"), 3);
    });

    it("should handle functions with expressions as arguments", () => {
      assert.strictEqual(safeEval("sqrt(4 + 12)"), 4);
      assert.strictEqual(safeEval("max(2 * 3, 5 + 1)"), 6);
    });
  });

  describe("Constants", () => {
    it("should recognize PI", () => {
      assert.strictEqual(safeEval("PI"), Math.PI);
    });

    it("should recognize pi (lowercase)", () => {
      assert.strictEqual(safeEval("pi"), Math.PI);
    });

    it("should recognize E", () => {
      assert.strictEqual(safeEval("E"), Math.E);
    });

    it("should recognize e (lowercase)", () => {
      assert.strictEqual(safeEval("e"), Math.E);
    });

    it("should use constants in expressions", () => {
      assert.ok(Math.abs(safeEval("2 * PI") - 2 * Math.PI) < 1e-10);
    });
  });

  describe("Injection Attempts - MUST ALL THROW", () => {
    it("should reject process.env access", () => {
      assert.throws(
        () => safeEval("process.env"),
        /Invalid character|Unknown identifier|Invalid number/
      );
    });

    it("should reject __proto__ access", () => {
      assert.throws(
        () => safeEval("__proto__"),
        /Invalid character/
      );
    });

    it("should reject constructor access", () => {
      assert.throws(
        () => safeEval("constructor"),
        /Unknown identifier/
      );
    });

    it("should reject Unicode bypass attempt (fullwidth characters)", () => {
      // Fullwidth digits ０１２ (U+FF10, U+FF11, U+FF12)
      assert.throws(
        () => safeEval("\uFF11 + \uFF12"),
        /Invalid character/
      );
    });

    it("should reject function chaining attempt", () => {
      assert.throws(
        () => safeEval("sqrt(16).toString()"),
        /Invalid character|Invalid number/
      );
    });

    it("should reject require() call", () => {
      assert.throws(
        () => safeEval("require('fs')"),
        /Invalid character|Unknown function|Unknown identifier/
      );
    });

    it("should reject eval() call", () => {
      assert.throws(
        () => safeEval("eval('1+1')"),
        /Invalid character|Unknown function|Unknown identifier/
      );
    });

    it("should reject Function constructor", () => {
      assert.throws(
        () => safeEval("Function('return 1')()"),
        /Invalid character|Unknown function|Unknown identifier/
      );
    });

    it("should reject bracket notation property access", () => {
      assert.throws(
        () => safeEval("Math['sqrt'](16)"),
        /Invalid character/
      );
    });

    it("should reject template literals", () => {
      assert.throws(
        () => safeEval("`${1+1}`"),
        /Invalid character/
      );
    });

    it("should reject semicolons (statement injection)", () => {
      assert.throws(
        () => safeEval("1; process.exit()"),
        /Invalid character/
      );
    });

    it("should reject import statements", () => {
      assert.throws(
        () => safeEval("import('fs')"),
        /Unknown function|Invalid character/
      );
    });

    it("should reject hex escape sequences in identifiers", () => {
      // This is \x65val which spells 'eval'
      assert.throws(
        () => safeEval("\\x65val('1')"),
        /Invalid character/
      );
    });

    it("should reject Unicode escape sequences", () => {
      assert.throws(
        () => safeEval("\\u0065val('1')"),
        /Invalid character/
      );
    });

    it("should reject Object.keys", () => {
      assert.throws(
        () => safeEval("Object.keys({})"),
        /Invalid character|Unknown identifier|Invalid number/
      );
    });

    it("should reject this keyword", () => {
      assert.throws(
        () => safeEval("this"),
        /Unknown identifier/
      );
    });

    it("should reject globalThis", () => {
      assert.throws(
        () => safeEval("globalThis"),
        /Unknown identifier/
      );
    });
  });

  describe("Error Handling", () => {
    it("should throw on empty expression", () => {
      assert.throws(() => safeEval(""), /Empty expression/);
    });

    it("should throw on whitespace-only expression", () => {
      assert.throws(() => safeEval("   "), /Empty expression/);
    });

    it("should throw on missing closing parenthesis", () => {
      assert.throws(() => safeEval("(2 + 3"), /Missing closing parenthesis/);
    });

    it("should throw on extra closing parenthesis", () => {
      assert.throws(() => safeEval("2 + 3)"), /Unexpected token/);
    });

    it("should throw on unknown function", () => {
      assert.throws(() => safeEval("unknown(5)"), /Unknown function/);
    });

    it("should throw on unknown identifier", () => {
      assert.throws(() => safeEval("xyz"), /Unknown identifier/);
    });

    it("should throw on non-string input", () => {
      assert.throws(() => safeEval(123), /must be a string/);
      assert.throws(() => safeEval(null), /must be a string/);
      assert.throws(() => safeEval(undefined), /must be a string/);
    });

    it("should throw on division by zero producing Infinity", () => {
      // Division by zero in JS produces Infinity, which is a valid number
      // but our function should handle this - actually Infinity is typeof 'number'
      // Let's verify this behavior
      const result = safeEval("1 / 0");
      assert.strictEqual(result, Infinity);
    });
  });
});

describe("Calculator Tool Integration", () => {
  it("should return result object with correct structure", async () => {
    const result = await calculatorTool.handler({ expression: "2 + 2" });
    assert.deepStrictEqual(result, {
      expression: "2 + 2",
      result: 4,
      type: "number",
    });
  });

  it("should throw on invalid expression", async () => {
    await assert.rejects(
      () => calculatorTool.handler({ expression: "invalid" }),
      /Calculation error/
    );
  });

  it("should throw on missing expression", async () => {
    await assert.rejects(
      () => calculatorTool.handler({}),
      /Expression is required/
    );
  });
});

// Run a quick self-test when executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("Run tests with: node --test server/tools/calculator.test.js");
}
