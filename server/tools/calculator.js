/**
 * Calculator Tool
 * Evaluates mathematical expressions using a secure allowlist-only parser.
 */

// Allowed functions mapped to Math implementations
const ALLOWED_FUNCTIONS = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  log: Math.log,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  max: Math.max,
  min: Math.min,
};

// Allowed constants
const ALLOWED_CONSTANTS = {
  PI: Math.PI,
  pi: Math.PI,
  E: Math.E,
  e: Math.E,
};

/**
 * Secure expression evaluator using allowlist-only recursive-descent parsing.
 * @param {string} expr - Mathematical expression to evaluate
 * @returns {number} - Result of the expression
 * @throws {Error} - On any invalid character or syntax error
 */
export function safeEval(expr) {
  if (typeof expr !== "string") {
    throw new Error("Expression must be a string");
  }

  const tokens = tokenize(expr);
  if (tokens.length === 0) {
    throw new Error("Empty expression");
  }

  const parser = new Parser(tokens);
  const result = parser.parseExpression();

  if (parser.pos < tokens.length) {
    throw new Error(`Unexpected token: ${tokens[parser.pos].value}`);
  }

  if (typeof result !== "number" || Number.isNaN(result)) {
    throw new Error("Expression did not evaluate to a valid number");
  }

  return result;
}

// Token types
const TokenType = {
  NUMBER: "NUMBER",
  IDENT: "IDENT",
  PLUS: "+",
  MINUS: "-",
  STAR: "*",
  SLASH: "/",
  CARET: "^",
  LPAREN: "(",
  RPAREN: ")",
  COMMA: ",",
};

/**
 * Tokenize expression using strict character allowlist.
 * @param {string} expr - Expression string
 * @returns {Array} - Array of tokens
 */
function tokenize(expr) {
  const tokens = [];
  let i = 0;

  while (i < expr.length) {
    const ch = expr[i];

    // Whitespace - skip
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }

    // Single-character operators
    if (ch === "+") {
      tokens.push({ type: TokenType.PLUS, value: "+" });
      i++;
      continue;
    }
    if (ch === "-") {
      tokens.push({ type: TokenType.MINUS, value: "-" });
      i++;
      continue;
    }
    if (ch === "*") {
      tokens.push({ type: TokenType.STAR, value: "*" });
      i++;
      continue;
    }
    if (ch === "/") {
      tokens.push({ type: TokenType.SLASH, value: "/" });
      i++;
      continue;
    }
    if (ch === "^") {
      tokens.push({ type: TokenType.CARET, value: "^" });
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: TokenType.LPAREN, value: "(" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: TokenType.RPAREN, value: ")" });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: TokenType.COMMA, value: "," });
      i++;
      continue;
    }

    // Numbers: digits and decimal point
    if ((ch >= "0" && ch <= "9") || ch === ".") {
      let num = "";
      let hasDot = false;
      while (i < expr.length) {
        const c = expr[i];
        if (c >= "0" && c <= "9") {
          num += c;
          i++;
        } else if (c === "." && !hasDot) {
          hasDot = true;
          num += c;
          i++;
        } else {
          break;
        }
      }
      const value = parseFloat(num);
      if (Number.isNaN(value)) {
        throw new Error(`Invalid number: ${num}`);
      }
      tokens.push({ type: TokenType.NUMBER, value });
      continue;
    }

    // Identifiers: letters only (a-z, A-Z)
    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z")) {
      let ident = "";
      while (i < expr.length) {
        const c = expr[i];
        if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z")) {
          ident += c;
          i++;
        } else {
          break;
        }
      }
      tokens.push({ type: TokenType.IDENT, value: ident });
      continue;
    }

    // Any other character is rejected (fail-closed)
    throw new Error(`Invalid character: '${ch}' (code: ${ch.charCodeAt(0)})`);
  }

  return tokens;
}

// Recursive-descent parser with correct operator precedence.
// Precedence (lowest to highest): +- then */ then ^ then unary/functions/atoms
class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos] || null;
  }

  consume() {
    return this.tokens[this.pos++];
  }

  // Entry point: parse addition/subtraction (lowest precedence)
  parseExpression() {
    let left = this.parseTerm();

    while (this.peek()) {
      const token = this.peek();
      if (token.type === TokenType.PLUS) {
        this.consume();
        left = left + this.parseTerm();
      } else if (token.type === TokenType.MINUS) {
        this.consume();
        left = left - this.parseTerm();
      } else {
        break;
      }
    }

    return left;
  }

  // Parse multiplication/division
  parseTerm() {
    let left = this.parsePower();

    while (this.peek()) {
      const token = this.peek();
      if (token.type === TokenType.STAR) {
        this.consume();
        left = left * this.parsePower();
      } else if (token.type === TokenType.SLASH) {
        this.consume();
        left = left / this.parsePower();
      } else {
        break;
      }
    }

    return left;
  }

  // Parse exponentiation (right-associative, highest binary precedence)
  parsePower() {
    const base = this.parseUnary();

    if (this.peek() && this.peek().type === TokenType.CARET) {
      this.consume();
      const exponent = this.parsePower(); // Right-associative
      return Math.pow(base, exponent);
    }

    return base;
  }

  // Parse unary minus
  parseUnary() {
    if (this.peek() && this.peek().type === TokenType.MINUS) {
      this.consume();
      return -this.parseUnary();
    }
    if (this.peek() && this.peek().type === TokenType.PLUS) {
      this.consume();
      return this.parseUnary();
    }
    return this.parseAtom();
  }

  // Parse atoms: numbers, constants, functions, parentheses
  parseAtom() {
    const token = this.peek();

    if (!token) {
      throw new Error("Unexpected end of expression");
    }

    // Number literal
    if (token.type === TokenType.NUMBER) {
      this.consume();
      return token.value;
    }

    // Parenthesized expression
    if (token.type === TokenType.LPAREN) {
      this.consume();
      const value = this.parseExpression();
      if (!this.peek() || this.peek().type !== TokenType.RPAREN) {
        throw new Error("Missing closing parenthesis");
      }
      this.consume();
      return value;
    }

    // Identifier: constant or function
    if (token.type === TokenType.IDENT) {
      this.consume();
      const name = token.value;

      // Check if it's a function call
      if (this.peek() && this.peek().type === TokenType.LPAREN) {
        if (!Object.prototype.hasOwnProperty.call(ALLOWED_FUNCTIONS, name)) {
          throw new Error(`Unknown function: ${name}`);
        }
        this.consume(); // consume '('

        const args = [];
        if (this.peek() && this.peek().type !== TokenType.RPAREN) {
          args.push(this.parseExpression());
          while (this.peek() && this.peek().type === TokenType.COMMA) {
            this.consume();
            args.push(this.parseExpression());
          }
        }

        if (!this.peek() || this.peek().type !== TokenType.RPAREN) {
          throw new Error(`Missing closing parenthesis for function ${name}`);
        }
        this.consume(); // consume ')'

        const fn = ALLOWED_FUNCTIONS[name];
        const result = fn(...args);
        if (typeof result !== "number" || Number.isNaN(result)) {
          throw new Error(`Function ${name} returned invalid result`);
        }
        return result;
      }

      // Otherwise it's a constant
      if (Object.prototype.hasOwnProperty.call(ALLOWED_CONSTANTS, name)) {
        return ALLOWED_CONSTANTS[name];
      }

      throw new Error(`Unknown identifier: ${name}`);
    }

    throw new Error(`Unexpected token: ${token.value}`);
  }
}

export default {
  name: "calculator",
  description:
    "Evaluate a mathematical expression. Supports basic arithmetic, trigonometry, logarithms, and constants like pi and e.",
  parameters: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description:
          "The mathematical expression to evaluate (e.g., '2 + 2', 'sqrt(16)', 'sin(pi/2)', '2^10')",
      },
    },
    required: ["expression"],
  },
  handler: async (args) => {
    const { expression } = args;

    if (!expression || typeof expression !== "string") {
      throw new Error("Expression is required and must be a string");
    }

    try {
      const result = safeEval(expression);

      return {
        expression,
        result,
        type: typeof result,
      };
    } catch (error) {
      throw new Error(`Calculation error: ${error.message}`);
    }
  },
};
