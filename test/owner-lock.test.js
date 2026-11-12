// Only the owner may drive a bot that can buy, sell and add wallets to copy.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

delete process.env.TELEGRAM_ADMIN_IDS;
const SRC = path.join(__dirname, '..', 'src', 'v2');

const store = { adminChatId: null, fail: false, writes: 0 };
const BotSettings = {
    findOne: async () => { if (store.fail) throw new Error('db down'); return store.adminChatId ? { adminChatId: store.adminChatId } : null; },
    findOneAndUpdate: async (q, update) => { store.writes++; store.adminChatId = update.adminChatId; return {}; }
};
function inject(file, exports) {
    const id = require.resolve(file);
    const m = new Module(id);
    m.filename = id; m.loaded = true; m.exports = exports;
    require.cache[id] = m;
}
inject(path.join(SRC, 'models', 'BotSettings.js'), BotSettings);
inject(path.join(SRC, 'services', 'solana.service.js'), { getSolPriceUSD: () => 100 });

const tg = require(path.join(SRC, 'services', 'telegram.service.js'));
const fresh = () => { tg.ownerIds = undefined; tg.adminChatId = null; };
const ctxOf = ({ id, text, type = 'private', updateType = 'message', callback = false }) => {
    const ctx = { updateType, from: id ? { id } : undefined, chat: { type, id }, message: text ? { text } : undefined, answered: null };
    if (callback) { ctx.callbackQuery = {}; ctx.answerCbQuery = async (t) => { ctx.answered = t; }; }
    return ctx;
};
const run = async (ctx) => { let passed = false; await tg.ownerGate(ctx, async () => { passed = true; }); return passed; };

test('with an owner on record, only that user gets through', async () => {
    fresh(); store.adminChatId = '555'; store.fail = false;
    await tg.loadOwner();
    assert.equal(await run(ctxOf({ id: 555, text: '/panic' })), true);
    assert.equal(await run(ctxOf({ id: 999, text: '/panic' })), false);
    assert.equal(await run(ctxOf({ id: 999, text: '/watch SomeWallet' })), false);
    assert.equal(store.adminChatId, '555', 'a stranger must not replace the owner');
    assert.equal(tg.adminChatId, '555');
});

test('strangers cannot press trade buttons', async () => {
    const ctx = ctxOf({ id: 999, callback: true, updateType: 'callback_query' });
    assert.equal(await run(ctx), false);
    assert.equal(ctx.answered, 'Not authorized.');
});

test('strangers can still read pricing, and nothing else', async () => {
    let shown = 0;
    const real = tg.handlePricing;
    tg.handlePricing = async () => { shown++; };
    assert.equal(await run(ctxOf({ id: 999, text: '/pricing' })), false);
    assert.equal(await run(ctxOf({ id: 999, text: '/start' })), false);
    assert.equal(await run(ctxOf({ id: 999, text: '/stats' })), false);
    tg.handlePricing = real;
    assert.equal(shown, 2);
});

test('channel membership updates always pass (demo passes keep working)', async () => {
    assert.equal(await run(ctxOf({ id: 999, updateType: 'chat_member', type: 'channel' })), true);
});

test('the owner can use the bot from a group too', async () => {
    assert.equal(await run(ctxOf({ id: 555, text: '/stats', type: 'supergroup' })), true);
});

test('first run with nothing on record: the first private chat claims ownership once', async () => {
    fresh(); store.adminChatId = null; store.writes = 0;
    await tg.loadOwner();
    assert.equal(await run(ctxOf({ id: 42, text: '/start', type: 'supergroup' })), false, 'cannot be claimed from a group');
    assert.equal(await run(ctxOf({ id: 42, text: '/start' })), true);
    assert.equal(store.adminChatId, '42');
    assert.equal(await run(ctxOf({ id: 43, text: '/panic' })), false);
    assert.equal(store.writes, 1);
});

test('if the database cannot be read, ownership is NOT handed out', async () => {
    fresh(); store.adminChatId = null; store.fail = true;
    await tg.loadOwner();
    assert.equal(await run(ctxOf({ id: 77, text: '/panic' })), false);
    store.fail = false;
});
