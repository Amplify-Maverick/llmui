/**
 * Calculator Tool
 * Evaluates mathematical expressions using mathjs in a sandboxed environment.
 */

import { create, all } from "mathjs";

// Create a sandboxed mathjs instance with limited functionality
const math = create(all);

// Remove potentially dangerous functions
const BLOCKED_FUNCTIONS = [
  "import",
  "createUnit",
  "evaluate",
  "parse",
  "compile",
  "parser",
  "chain",
  "resolve",
  "help",
  "typed",
];

// Create a limited scope - no access to Node.js internals
const limitedScope = {};

export default {
  name: "calculator",
  description: "Evaluate a mathematical expression. Supports basic arithmetic, trigonometry, logarithms, and constants like pi and e.",
  parameters: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: "The mathematical expression to evaluate (e.g., '2 + 2', 'sqrt(16)', 'sin(pi/2)', '2^10')",
      },
    },
    required: ["expression"],
  },
  handler: async (args) => {
    const { expression } = args;

    if (!expression || typeof expression !== "string") {
      throw new Error("Expression is required and must be a string");
    }

    // Check for blocked function calls
    const lowerExpr = expression.toLowerCase();
    for (const blocked of BLOCKED_FUNCTIONS) {
      if (lowerExpr.includes(blocked)) {
        throw new Error(`Function '${blocked}' is not allowed`);
      }
    }

    // Block potential code injection patterns
    if (expression.includes("constructor") || expression.includes("__proto__")) {
      throw new Error("Invalid expression");
    }

    try {
      const result = math.evaluate(expression, limitedScope);

      // Handle different result types
      if (typeof result === "function") {
        throw new Error("Expression returned a function, which is not allowed");
      }

      // Convert mathjs types to plain values
      let plainResult;
      if (typeof result === "object" && result !== null) {
        if (typeof result.toNumber === "function") {
          plainResult = result.toNumber();
        } else if (typeof result.toString === "function") {
          plainResult = result.toString();
        } else {
          plainResult = JSON.parse(JSON.stringify(result));
        }
      } else {
        plainResult = result;
      }

      return {
        expression,
        result: plainResult,
        type: typeof plainResult,
      };
    } catch (error) {
      throw new Error(`Calculation error: ${error.message}`);
    }
  },
};
