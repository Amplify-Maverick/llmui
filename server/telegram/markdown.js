// Markdown to Telegram HTML converter
// Telegram supports a limited HTML subset: <b>, <i>, <u>, <s>, <code>, <pre>, <a>

/**
 * Escape HTML entities for safe display in Telegram
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Convert markdown to Telegram-safe HTML
 *
 * Supports:
 * - Code blocks (```lang\n...\n```) -> <pre><code class="language-...">...</code></pre>
 * - Inline code (`...`) -> <code>...</code>
 * - Bold (**x** or __x__) -> <b>x</b>
 * - Italic (*x* or _x_) -> <i>x</i>
 * - Strikethrough (~~x~~) -> <s>x</s>
 * - Links [text](url) -> <a href="url">text</a>
 * - Headers (# ## ###) -> bold lines
 * - Lists (- or *) -> bullet points
 * - Blockquotes (>) -> plain text with indent
 *
 * @param {string} markdown - Input markdown text
 * @returns {string} - Telegram-safe HTML
 */
export function markdownToTelegramHtml(markdown) {
  if (!markdown) return '';

  let result = markdown;

  // First, extract and protect code blocks
  const codeBlocks = [];
  result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, (match, lang, code) => {
    const index = codeBlocks.length;
    const escapedCode = escapeHtml(code.trim());
    const langAttr = lang ? ` class="language-${lang}"` : '';
    codeBlocks.push(`<pre><code${langAttr}>${escapedCode}</code></pre>`);
    return `\x00CODEBLOCK${index}\x00`;
  });

  // Extract and protect inline code
  const inlineCodes = [];
  result = result.replace(/`([^`\n]+)`/g, (match, code) => {
    const index = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00INLINECODE${index}\x00`;
  });

  // Extract and protect links (before escaping)
  const links = [];
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
    const index = links.length;
    // Escape text but not the URL structure
    links.push(`<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`);
    return `\x00LINK${index}\x00`;
  });

  // Now escape HTML in remaining text
  result = escapeHtml(result);

  // Convert headers to bold (# Header -> <b>Header</b>)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // Convert bold (**text** or __text__)
  result = result.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  result = result.replace(/__([^_]+)__/g, '<b>$1</b>');

  // Convert italic (*text* or _text_) - careful not to match within words
  result = result.replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, '<i>$1</i>');
  result = result.replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, '<i>$1</i>');

  // Convert strikethrough (~~text~~)
  result = result.replace(/~~([^~]+)~~/g, '<s>$1</s>');

  // Convert unordered lists (- item or * item) to bullet points
  result = result.replace(/^[-*]\s+(.+)$/gm, '• $1');

  // Convert ordered lists (1. item) to numbered items
  result = result.replace(/^\d+\.\s+(.+)$/gm, (match, content) => `• ${content}`);

  // Convert blockquotes (> text) to indented text
  result = result.replace(/^>\s*(.+)$/gm, '  │ $1');

  // Restore protected content
  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (match, index) => codeBlocks[parseInt(index)]);
  result = result.replace(/\x00INLINECODE(\d+)\x00/g, (match, index) => inlineCodes[parseInt(index)]);
  result = result.replace(/\x00LINK(\d+)\x00/g, (match, index) => links[parseInt(index)]);

  return result;
}

/**
 * Split a long message into chunks that fit Telegram's 4096 character limit
 * Splits on paragraph boundaries when possible
 *
 * @param {string} text - The text to split
 * @param {number} maxLength - Maximum length per chunk (default 4096)
 * @returns {string[]} - Array of text chunks
 */
export function splitMessage(text, maxLength = 4096) {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to find a good split point
    let splitPoint = maxLength;

    // Try to split at paragraph boundary (double newline)
    const paragraphEnd = remaining.lastIndexOf('\n\n', maxLength);
    if (paragraphEnd > maxLength / 2) {
      splitPoint = paragraphEnd + 2;
    } else {
      // Try to split at single newline
      const lineEnd = remaining.lastIndexOf('\n', maxLength);
      if (lineEnd > maxLength / 2) {
        splitPoint = lineEnd + 1;
      } else {
        // Try to split at space
        const spaceEnd = remaining.lastIndexOf(' ', maxLength);
        if (spaceEnd > maxLength / 2) {
          splitPoint = spaceEnd + 1;
        }
        // Otherwise split at maxLength
      }
    }

    chunks.push(remaining.slice(0, splitPoint));
    remaining = remaining.slice(splitPoint);

    // Add continuation marker to subsequent chunks
    if (remaining.length > 0) {
      remaining = '(...)\n' + remaining;
    }
  }

  return chunks;
}

/**
 * Try to send a message with HTML formatting, fall back to plain text on parse error
 *
 * @param {Object} bot - Telegram bot instance
 * @param {number} chatId - Chat ID to send to
 * @param {string} text - Text to send (should be HTML-formatted)
 * @param {Object} options - Additional options for sendMessage
 * @returns {Promise<Object>} - Sent message object
 */
export async function sendFormattedMessage(bot, chatId, text, options = {}) {
  try {
    return await bot.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'HTML'
    });
  } catch (err) {
    if (err.message && err.message.includes("can't parse entities")) {
      // HTML parsing failed - log the error and send as plain text
      console.error('[Telegram] HTML parse failed, falling back to plain text:', err.message);

      // Strip HTML tags for plain text fallback
      const plainText = text
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');

      return await bot.sendMessage(chatId, plainText, {
        ...options,
        parse_mode: undefined
      });
    }
    throw err;
  }
}

/**
 * Try to edit a message with HTML formatting, fall back to plain text on parse error
 *
 * @param {Object} bot - Telegram bot instance
 * @param {string} text - Text to set (should be HTML-formatted)
 * @param {Object} options - Options including chat_id and message_id
 * @returns {Promise<Object>} - Edited message object or true if unchanged
 */
export async function editFormattedMessage(bot, text, options = {}) {
  try {
    return await bot.editMessageText(text, {
      ...options,
      parse_mode: 'HTML'
    });
  } catch (err) {
    if (err.message && err.message.includes("can't parse entities")) {
      // HTML parsing failed - send as plain text
      console.error('[Telegram] HTML parse failed on edit, falling back to plain text');

      const plainText = text
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');

      return await bot.editMessageText(plainText, {
        ...options,
        parse_mode: undefined
      });
    }
    // "message is not modified" is not a real error
    if (err.message && err.message.includes('message is not modified')) {
      return true;
    }
    throw err;
  }
}
