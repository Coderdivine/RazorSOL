# RazorSOL

Copy trading bot for Solana meme tokens, controlled from Telegram.

## Modes

| `TRADING_MODE` | What happens |
|---|---|
| `paper` (default) | Signals are tracked and fills are simulated against the live bonding curve or market price, with assumed slippage and fees. No funds move. Paper fills are sent to the owner only, never to the public channel. |
| `live` | Real orders. Each one is dry run first, then sent, confirmed and recorded from the actual transaction. |

Positions keep the mode they were opened in, so switching modes never strands an open live position.

## Setup

1. Copy `.env.example` to `.env` and fill it in.
2. Set `SOLANA_RPC_URL` to a keyed endpoint. A free Helius, QuickNode or Alchemy key is enough. The shared public endpoint is rate limited and causes missed signals and unconfirmed trades.
3. Set `TELEGRAM_ADMIN_IDS` to your Telegram user ID. Only these users can control the bot.
4. `npm install` then `npm start`.

## What the numbers mean

`/stats` and `/scorecard` only report trades whose fills were recorded: SOL that actually left and came back to the wallet (or the simulated equivalent in paper mode), fees included. Trades with no recorded fill are listed as not measured and contribute nothing. There are no estimates.

`/scorecard` shows results per copied wallet over 30 days. A wallet should earn live capital only after its paper results stay positive over a meaningful number of trades.

## Sizing

Each buy uses `TRADE_FRACTION` of the balance (default 25%), never less than `MIN_TRADE_SOL` and never so much that the worst case fill, fees, the token account deposit and `RESERVE_SOL` could not be paid. After a full exit the empty token account is closed to get its deposit back.

## Tests

```
npm test
```

The suite runs the real trade engine against in-memory fakes for the database, RPC, PumpPortal and Telegram. It never touches the network or real funds.
