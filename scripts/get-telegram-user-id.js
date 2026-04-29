#!/usr/bin/env node
/**
 * Helper script to get your Telegram user ID
 *
 * Usage:
 *   node scripts/get-telegram-user-id.js <BOT_TOKEN>
 *
 * This script polls the Telegram API once and prints the user ID
 * of anyone who has sent a message to the bot. Use this to populate
 * the allowed_user_ids field in ~/.llmui/telegram.json
 *
 * Steps:
 * 1. Create a bot via @BotFather and get the bot token
 * 2. Send a message to your bot on Telegram
 * 3. Run this script with your bot token
 * 4. Copy the user ID to your telegram.json config
 */

import TelegramBot from 'node-telegram-bot-api';

const token = process.argv[2];

if (!token) {
  console.error('Usage: node scripts/get-telegram-user-id.js <BOT_TOKEN>');
  console.error('');
  console.error('Example:');
  console.error('  node scripts/get-telegram-user-id.js 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11');
  process.exit(1);
}

console.log('Checking for messages...\n');

async function main() {
  try {
    // Create bot instance without polling
    const bot = new TelegramBot(token);

    // Get updates (pending messages)
    const updates = await bot.getUpdates({ limit: 100, timeout: 1 });

    if (updates.length === 0) {
      console.log('No pending messages found.');
      console.log('');
      console.log('Make sure you have sent a message to your bot on Telegram,');
      console.log('then run this script again.');
      process.exit(0);
    }

    console.log(`Found ${updates.length} message(s):\n`);

    // Track unique users
    const users = new Map();

    for (const update of updates) {
      if (update.message?.from) {
        const user = update.message.from;
        users.set(user.id, {
          id: user.id,
          username: user.username || '(no username)',
          firstName: user.first_name || '',
          lastName: user.last_name || ''
        });
      }
    }

    for (const [id, user] of users) {
      const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
      console.log(`  User ID: ${id}`);
      console.log(`  Username: @${user.username}`);
      if (name) console.log(`  Name: ${name}`);
      console.log('');
    }

    console.log('Add the user ID to your ~/.llmui/telegram.json:');
    console.log('');
    console.log('  {');
    console.log('    "enabled": true,');
    console.log(`    "bot_token": "${token}",`);
    console.log(`    "allowed_user_ids": [${[...users.keys()].join(', ')}],`);
    console.log('    "default_model": "llama3.2",');
    console.log('    "system_prompt": "",');
    console.log('    "command_prefix": "/"');
    console.log('  }');
    console.log('');
    console.log('Then restart the LLMUI server.');

  } catch (err) {
    if (err.message.includes('401')) {
      console.error('Error: Invalid bot token');
    } else {
      console.error('Error:', err.message);
    }
    process.exit(1);
  }
}

main();
