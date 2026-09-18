const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const {
  BOT_TOKEN, STORE_NAME, BOT_USERNAME, REFERRAL_REWARD, BOLT_EMOJI_ID_TEXT, BOLT_EMOJI_ID_MENU, isAdmin,
  ADMIN_IDS, PAYKITA_API_KEY, USDT_BEP20_ADDRESS, TON_ADDRESS, BINANCE_API_KEY, BINANCE_PAY_ID, AIVERSEHUB_API_KEY, SUPPLIER_SYNC_INTERVAL_MINUTES,
  DEFAULT_SUPPLIER_TIER_MARKUP, CANBOSO_API_KEY, CANBOSO_SYNC_INTERVAL_SECONDS,
  GIFT_MARKUP_PCT, STARS_TO_USD_RATE
} = require('./config');
const { iconFor, EMOJI_IDS } = require('./emoji-id-menu-inline');
const { EMOJI_ID_TEKS_BACKUP } = require('./emoji-id-teks');
const db = require('./db');
const payment = require('./payment');
const supplier = require('./supplier');
const canboso = require('./supplierCanboso');
const backup = require('./backup');
const totp = require('./totp');
const lang = require('./lang');
const userbot = require('./userbot'); // the "🎁 Buy Gift" / "💌 Confess Gift" features - see userbot.js

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ===== PATCH v4: concise error logging helper =====
// Several catch blocks used to call console.error(err) directly, which dumps the
// ENTIRE error object from the `request-promise` library (hundreds of lines: the
// raw HTTP request, socket, headers, and so on) into the log for every single
// error - including trivial, frequent ones such as "user blocked the bot"
// (Telegram returns 403 Forbidden when the bot tries to sendMessage to a user who
// has blocked it). That filled the log with noise and made it hard to find the
// errors that genuinely matter when something goes wrong.
// logError() below prints only the error message (not the whole object), and for
// 403 "blocked by user"/"user is deactivated" errors (the two most common cases,
// neither needing any admin action) it prints nothing at all - those are a normal
// part of running a bot with many users, not a bug.
const errorNotifyCooldown = new Map(); // "context|message" -> timestamp of the last notification
const ERROR_NOTIFY_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

function logError(context, err) {
  const msg = (err && err.message) || String(err);
  // ⚠️ "message is not modified" was added - a common and harmless Telegram Bot
  // API error when editMessageText/editMessageReplyMarkup is called with content
  // IDENTICAL to what is already displayed (a user tapping the same button twice
  // quickly, say). Nothing breaks, so there is no need to spam a 🚨 notification
  // to admins - it is skipped here like the other noise.
  const isHarmlessTelegramNoise = /blocked by the user|user is deactivated|chat not found|message is not modified/i.test(msg);
  if (isHarmlessTelegramNoise) return; // ordinary noise, no need to log it
  console.error(`[${context}]`, msg);

  // ---- 24-hour monitoring: forward important errors to admins via Telegram ----
  // Errors used to appear only in `pm2 logs`, so an admin noticed them only if
  // they happened to open a terminal (see the earlier Buy Gift/Binance Pay
  // incidents). Now this logError() (called from ALMOST EVERY catch block in
  // bot.js plus process.on('unhandledRejection'/'uncaughtException') above)
  // broadcasts to ADMIN_IDS automatically. It is rate-limited PER context+message
  // (not globally) so that an error repeating every few seconds (polling failing
  // continuously, say) does not spam admins with hundreds of identical
  // notifications - just one per 10 minutes for the exact same error.
  try {
    const key = `${context}|${msg}`;
    const now = Date.now();
    const last = errorNotifyCooldown.get(key) || 0;
    if (now - last >= ERROR_NOTIFY_COOLDOWN_MS) {
      errorNotifyCooldown.set(key, now);
      const stack = err && err.stack ? String(err.stack).slice(0, 1000) : '';
      notifyAdmins(
        `🚨 <b>Bot Error</b>\n\n` +
        `Context: <code>${escapeHtml(context)}</code>\n` +
        `Message: <code>${escapeHtml(msg)}</code>` +
        (stack ? `\n\n<pre>${escapeHtml(stack)}</pre>` : '') +
        `\n\n<i>This notification is rate-limited to once per 10 minutes per error type.</i>`
      );
    }
  } catch (notifyErr) {
    console.error('[logError->notifyAdmins]', notifyErr.message);
  }
}

// An anti double-spend guard for the 'confirm:' (place order) flow. Without it, a
// user double-tapping "Place Order" (or Telegram retrying the callback itself on
// a slow connection) could trigger 2+ 'confirm:' handlers running AT THE SAME
// TIME for the same chatId. Both could pass the balance check (the
// "user.balance < total" line) BEFORE either deducted the balance - and for
// orders going through the Supplier API the window is even wider, because there
// is an `await supplier.placeOrder()` (a network call) between checking and
// deducting. The result: a user's balance could go negative and the store loses
// twice over (paying the supplier twice for a balance that only covered one).
// This set holds back the SECOND (and any later) confirm for the same chatId
// while the FIRST is still being processed.
const pendingOrderConfirms = new Set();

// ================= GLOBAL ERROR SAFETY NET =================
// Without these, ONE promise rejection not caught anywhere (an external API fetch
// failing oddly, an error from a third-party library) could crash the WHOLE Node
// process (modern Node's default behaviour) - the bot dying suddenly and needing
// a manual Start from the panel. Now it is simply logged and the bot stays alive.
process.on('unhandledRejection', (reason) => {
  logError('unhandledRejection', reason);
});
process.on('uncaughtException', (err) => {
  logError('uncaughtException', err);
});
// When the polling connection to Telegram drops (the server's internet blipping,
// say), this library emits a 'polling_error' event - without a listener here the
// error would vanish silently with no log at all, making it hard to diagnose.
bot.on('polling_error', (err) => {
  console.error('⚠️ Telegram polling error:', err.message);
});

// usd(n) - format a price in the store's currency (USD). The second argument is
// accepted and ignored: it used to select a per-customer currency, and is kept in
// the signature so the many existing call sites need no change.
const usd = (n, _chatId) => {
  const amount = Number(n);
  return '$' + amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const rupiah = (n) => 'Rp' + Math.round(Number(n)).toLocaleString('id-ID');

// The USD -> IDR rate is used ONLY for QRIS payments (QRIS in Indonesia only
// supports Rupiah amounts). The store still uses USD as its main currency (wallet
// balance, product prices, and so on). The rate is fetched AUTOMATICALLY from the
// live USDT/IDR price on CoinGecko (see getUsdToIdrRate() in payment.js, cached
// for 5 minutes) - the USD_TO_IDR_RATE value in .env is only a FALLBACK for when
// the live rate API is down or times out, so it does not need updating by hand
// every day.
const USD_TO_IDR_RATE_FALLBACK = Number(process.env.USD_TO_IDR_RATE) || 17750;
// The TON -> USD rate is used to work out how much TON matches the USD amount a
// user requests when topping up with TON. Fetched live (see getTonToUsdRate() in
// payment.js, cached for 5 minutes) - the TON_TO_USD_RATE value in .env is only a
// fallback for when the live rate API is down or times out AND no fetch has ever
// succeeded since the bot started.
const TON_TO_USD_RATE_FALLBACK = Number(process.env.TON_TO_USD_RATE) || 5;
// Minimum QRIS payment amount in Rupiah - below this, QRIS providers
// (ShopeePay/GoPay/etc.) usually reject the payment.
const MIN_QRIS_IDR = 1000;
// Recalculate the USD minimum from the LIVE rate at that moment (rounded up to
// the cent), so the user only has to think in USD while typing - no mental
// conversion to Rupiah, and it adjusts automatically as the rate moves.
async function getMinQrisUsd() {
  const rate = await payment.getUsdToIdrRate(USD_TO_IDR_RATE_FALLBACK);
  return Math.ceil((MIN_QRIS_IDR / rate) * 100) / 100;
}

// ================= WALLET TOPUP (QRIS & USDT BEP20 - OTOMATIS) =================

const QRIS_POLL_INTERVAL_MS = 7000;         // check the status every 7 seconds
const QRIS_EXPIRE_MS = 10 * 60 * 1000;      // the QR is valid for 10 minutes
const USDT_POLL_INTERVAL_MS = 20000;        // check on-chain activity every 20 seconds
const USDT_EXPIRE_MS = 30 * 60 * 1000;      // the address/amount is valid for 30 minutes
const TON_POLL_INTERVAL_MS = 15000;         // check on-chain activity every 15 seconds
const TON_EXPIRE_MS = 30 * 60 * 1000;       // the address/amount is valid for 30 minutes
const BINANCE_POLL_INTERVAL_MS = 20000;     // check Binance Pay history every 20 seconds
const BINANCE_EXPIRE_MS = 30 * 60 * 1000;   // the Binance ID/amount is valid for 30 minutes
const MIN_TOPUP_AMOUNT = 1;                 // minimum topup amount (USD) - used by QRIS
const MIN_TOPUP_USDT_AMOUNT = 0.1;          // minimum topup amount specific to USDT (BEP20)
const MIN_TOPUP_TON_AMOUNT = 0.1;           // nominal topup minimum khusus TON
const MIN_TOPUP_BINANCE_AMOUNT = 0.1;       // nominal topup minimum khusus Binance Pay

// The LAST "🛒 Buy Product" message each user has open (chatId -> messageId) -
// used by scheduleProductListRepaint() to repaint the button colours
// (green/red, see productListKeyboard()) when stock changes AFTER that message
// was sent, without the user having to close and reopen the menu. In memory only
// (not stored in db.json) - enough for this UI nicety, and it simply empties
// again on a bot restart (the user just reopens the menu once to be tracked
// again, with no functional impact).
const openProductListMsg = new Map();
// ===== PATCH v4: tracking the product DETAIL page (not just the list) =====
// The same idea as openProductListMsg above, but for the detail page
// (descKeyboard, the "Buy Now" button) - so the "Buy Now" button colour also
// auto-repaints every PRODUCT_LIST_REPAINT_INTERVAL_MS while the buyer still has
// that detail page open, rather than only once when the page first opened. The
// value stores productId+variantId (not just messageId) - unlike the product
// list, whose keyboard is the same for everyone, this detail page is specific to
// the product/variant the buyer is looking at.
const openProductDescMsg = new Map(); // chatId -> { messageId, productId, variantId }
const MAX_TOPUP_AMOUNT = 10000;             // maximum topup amount (USD) - adjust if needed
// Threshold for the userbot's Stars balance - when the remaining Stars fall below
// this AFTER a gift is sent successfully, every admin gets a one-off notification
// (see maybeNotifyLowStars() near executeGiftSend()) so they can top up before the
// next buyer hits "out of Stars, order delayed".
const GIFT_LOW_STARS_THRESHOLD = 100;

function topupMethodKeyboard(chatId) {
  return {
    inline_keyboard: [
      [withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_topup_qris'), callback_data: 'topup:qris' }, 'topup_qris'), 'primary')],
      [withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_topup_usdt'), callback_data: 'topup:usdt' }, 'topup_usdt'), 'primary')],
      [withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_topup_ton'), callback_data: 'topup:ton' }, 'topup_ton'), 'primary')],
      [withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_topup_binance'), callback_data: 'topup:binance' }, 'topup_binance'), 'primary')],
      [withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_back'), callback_data: 'menu:main' }, 'back'), 'danger')]
    ]
  };
}

function cancelToTopupKeyboard(chatId) {
  return { inline_keyboard: [[withButtonIcon({ text: lang.t(chatId, 'btn_cancel_arrow'), callback_data: 'menu:topup' }, 'batal')]] };
}

const QRIS_QUICK_AMOUNTS = [1, 5, 10, 25, 50, 100];

function qrisAmountKeyboard(chatId) {
  const rows = [];
  for (let i = 0; i < QRIS_QUICK_AMOUNTS.length; i += 2) {
    rows.push(
      QRIS_QUICK_AMOUNTS.slice(i, i + 2).map(v =>
        withStyle(withButtonIcon({ text: usd(v, chatId), callback_data: `qrisamt:${v}` }, 'nominal_cepat'), 'primary')
      )
    );
  }
  rows.push([withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_custom_amount'), callback_data: 'qris:custom' }, 'nominal_custom'), 'primary')]);
  rows.push([withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_back'), callback_data: 'menu:topup' }, 'back'), 'danger')]);
  return { inline_keyboard: rows };
}

function cancelToQrisAmountKeyboard(chatId) {
  return { inline_keyboard: [[withButtonIcon({ text: lang.t(chatId, 'btn_cancel_arrow'), callback_data: 'topup:qris' }, 'batal')]] };
}

function qrisCancelKeyboard(chatId, depositId) {
  return { inline_keyboard: [[withButtonIcon({ text: lang.t(chatId, 'btn_qris_cancel'), callback_data: `qris:cancel:${depositId}` }, 'batalkan_qris')]] };
}

async function startQrisTopup(chatId, amountUsd) {
  const rate = await payment.getUsdToIdrRate(USD_TO_IDR_RATE_FALLBACK);
  const amountIdr = Math.round(amountUsd * rate);
  if (amountIdr < MIN_QRIS_IDR) {
    const minUsd = Math.ceil((MIN_QRIS_IDR / rate) * 100) / 100;
    return bot.sendMessage(
      chatId,
      lang.t(chatId, 'qris_too_small', { min: usd(minUsd, chatId) }),
      { parse_mode: 'Markdown' }
    );
  }

  const reference = 'DEP-' + Date.now() + '-' + chatId;
  let order;
  try {
    // PayKita/QRIS only accepts Rupiah amounts, so base_amount here is already in
    // IDR (converted from the USD amount the user requested).
    order = await payment.paykitaCreateOrder(amountIdr, reference);
  } catch (err) {
    console.error('PayKita create order error:', err.message);
    return bot.sendMessage(chatId, lang.t(chatId, 'qris_create_failed'), { parse_mode: 'Markdown' });
  }

  const deposit = db.createDeposit({
    chatId,
    method: 'qris',
    requestedAmount: amountUsd,
    requestedAmountIdr: amountIdr,
    expiresAt: new Date(Date.now() + QRIS_EXPIRE_MS).toISOString(),
    paykitaOrderId: order.orderId,
    paykitaReference: reference,
    finalAmount: order.finalAmount
  });

  const caption = lang.t(chatId, 'qris_invoice_caption', {
    orderId: deposit.id,
    amount: usd(amountUsd, chatId),
    total: rupiah(order.finalAmount),
    // Per-line emoji come from teksEmoji() so the custom emoji an admin sets in
    // "🎨 Manage Emoji ID" -> "QRIS Invoice (Topup)" take effect.
    title_icon: teksEmoji('qris_title', '🪙'),
    rocket_icon: teksEmoji('qris_rocket', '🚀'),
    orderid_icon: teksEmoji('qris_orderid', '🧾'),
    saldo_icon: teksEmoji('qris_saldo', '💵'),
    total_icon: teksEmoji('qris_total', '💰'),
    expire_icon: teksEmoji('qris_expire', '⏳'),
    carabayar_icon: teksEmoji('qris_carabayar', '📲'),
    step1_icon: teksEmoji('qris_step1', '1️⃣'),
    step2_icon: teksEmoji('qris_step2', '2️⃣'),
    step3_icon: teksEmoji('qris_step3', '3️⃣'),
    auto_icon: teksEmoji('qris_auto', '⚡'),
    tip_icon: teksEmoji('qris_tip', '💡')
  });

  const replyMarkup = qrisCancelKeyboard(chatId, deposit.id);
  let sentMsg;
  try {
    if (order.qrImage) {
      sentMsg = await bot.sendPhoto(chatId, order.qrImage, { caption, parse_mode: 'HTML', reply_markup: replyMarkup });
    } else if (order.qrString) {
      const QRCode = require('qrcode');
      const buffer = await QRCode.toBuffer(order.qrString, { width: 512, margin: 1 });
      sentMsg = await bot.sendPhoto(chatId, buffer, { caption, parse_mode: 'HTML', reply_markup: replyMarkup });
    } else {
      sentMsg = await bot.sendMessage(chatId, caption, { parse_mode: 'HTML', reply_markup: replyMarkup });
    }
    db.updateDeposit(deposit.id, { qrChatId: chatId, qrMessageId: sentMsg.message_id });
  } catch (err) {
    console.error('Failed to send the QR:', err.message);
    await bot.sendMessage(chatId, caption + lang.t(chatId, 'qris_qr_send_failed'), { parse_mode: 'HTML', reply_markup: replyMarkup });
  }

  pollQrisDeposit(deposit.id);
}

function pollQrisDeposit(depositId) {
  // A guard so the NEXT tick does not start while the PREVIOUS one is still
  // waiting on an API response (a slow or hanging API) - without it two ticks
  // could overlap, both find the status "paid", and both credit the user's
  // balance -> a DOUBLE CREDIT from one payment. See USDT/TON as well.
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const deposit = db.getDeposit(depositId);
      if (!deposit || deposit.status !== 'pending') return clearInterval(timer);

      // ===== BUG FIX (the "paid but not credited" complaint): PREVIOUSLY the
      // order of checks was expiry FIRST, then matching. If a buyer transferred
      // close to the deadline (or PayKita's confirmation was delayed), on the
      // LAST tick the bot declared "expired" and returned WITHOUT ever checking
      // the paid status at all - even though the payment was genuinely valid.
      // Now the match/status is ALWAYS checked first on every tick (including a
      // tick that happens to be past expiresAt), and expiry is only declared when
      // no match was found at all.
      try {
        const result = await payment.paykitaGetOrderStatus(deposit.paykitaOrderId);
        if (result && result.paid) {
          // Re-read the deposit AFTER the await, then check its status again - in
          // case, while waiting on PayKita's response above, this deposit was
          // cancelled or expired elsewhere (the user pressing "❌ Cancel QRIS" at
          // the same moment, say). Without this a 'cancelled' status could be
          // overwritten back to 'paid' and the balance credited even though the
          // user had cancelled. The same pattern is already used in
          // pollUsdtDeposit()/pollTonDeposit().
          const fresh = db.getDeposit(depositId);
          if (!fresh || fresh.status !== 'pending') return;
          db.updateDeposit(depositId, { status: 'paid', paidAt: new Date().toISOString() });
          clearInterval(timer);
          if (fresh.qrChatId && fresh.qrMessageId) {
            bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: fresh.qrChatId, message_id: fresh.qrMessageId }).catch(() => {});
          }
          const newBalance = db.updateBalance(fresh.chatId, fresh.requestedAmount);
          triggerReferralRewardIfEligible(fresh.chatId); // PATCH v7: check and credit the referral reward if this is the user's first deposit
          bot.sendMessage(
            fresh.chatId,
            lang.t(fresh.chatId, 'qris_paid', { amount: usd(fresh.requestedAmount, fresh.chatId), balance: usd(newBalance, fresh.chatId) }),
            { parse_mode: 'Markdown' }
          ).catch(() => {});
          // Automatic channel notification: "💳 New Wallet Top-Up!" (when the feature is on).
          sendChannelNotif('topup', buildChannelTopupText(fresh.chatId, 'qris', fresh.requestedAmount));
          return;
        }
      } catch (err) {
        console.error(`QRIS status check (${depositId}) error:`, err.message);
      }

      if (Date.now() > new Date(deposit.expiresAt).getTime()) {
        // Check the current status once more before really expiring it - in case
        // the match above ACTUALLY succeeded but the paid branch failed to write
        // to the DB because of some other error (defensive; this should rarely
        // happen).
        const fresh = db.getDeposit(depositId);
        if (!fresh || fresh.status !== 'pending') return;
        db.updateDeposit(depositId, { status: 'expired' });
        clearInterval(timer);
        if (fresh.qrChatId && fresh.qrMessageId) {
          bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: fresh.qrChatId, message_id: fresh.qrMessageId }).catch(() => {});
        }
        bot.sendMessage(fresh.chatId, lang.t(fresh.chatId, 'qris_expired', { id: depositId }), { parse_mode: 'Markdown' }).catch(() => {});
      }
    } finally {
      busy = false;
    }
  }, QRIS_POLL_INTERVAL_MS);
}

async function startUsdtTopup(chatId, usdAmount) {
  // The store already prices in USD and USDT is pegged ~1:1 to USD, so no conversion is needed.
  const baseUsdt = usdAmount;
  const usedAmounts = db.getUsedUsdtAmounts();
  const uniqueAmount = payment.generateUniqueUsdtAmount(baseUsdt, usedAmounts);

  const deposit = db.createDeposit({
    chatId,
    method: 'usdt_bep20',
    requestedAmount: usdAmount,
    expiresAt: new Date(Date.now() + USDT_EXPIRE_MS).toISOString(),
    usdtAmount: uniqueAmount,
    walletAddress: payment.USDT_BEP20_ADDRESS
  });

  const text = lang.t(chatId, 'usdt_invoice_text', {
    min: usd(MIN_TOPUP_USDT_AMOUNT, chatId),
    max: usd(MAX_TOPUP_AMOUNT, chatId),
    orderId: deposit.id,
    uniqueAmount,
    address: payment.USDT_BEP20_ADDRESS,
    // Per-line emoji come from teksEmoji() so the custom emoji an admin sets in
    // "🎨 Manage Emoji ID" -> "USDT Deposit (BEP20)" take effect.
    title_icon: teksEmoji('usdt_title', '🪙'),
    min_icon: teksEmoji('usdt_min', '🈷️'),
    max_icon: teksEmoji('usdt_max', '🈷️'),
    address_icon: teksEmoji('usdt_address_label', '🔺'),
    auto_icon: teksEmoji('usdt_auto', '✅')
  });

  const replyMarkup = {
    inline_keyboard: [
      [withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_copy_address'), copy_text: { text: payment.USDT_BEP20_ADDRESS } }, 'copy_address_usdt'), 'primary')],
      [withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_usdt_cancel'), callback_data: `usdt:cancel:${deposit.id}` }, 'batalkan_usdt'), 'danger')]
    ]
  };

  const sentMsg = await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: replyMarkup });
  db.updateDeposit(deposit.id, { qrChatId: chatId, qrMessageId: sentMsg.message_id });
  pollUsdtDeposit(deposit.id);
}

function pollUsdtDeposit(depositId) {
  // See the "busy" comment in pollQrisDeposit() - the same guard is crucial here,
  // because calls to the on-chain API are often slow or fail, so the chance of
  // ticks overlapping is far higher than with QRIS.
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const deposit = db.getDeposit(depositId);
      if (!deposit || deposit.status !== 'pending') return clearInterval(timer);

      // ===== BUG FIX (the "paid but not credited" complaint): the order of
      // checks is reversed - a match is ALWAYS looked for first on every tick
      // (including one already past expiresAt), and expiry is only declared when
      // none is found. See the fuller comment in pollQrisDeposit().
      try {
        const transfers = await payment.fetchIncomingUsdtTransfers();
        // Re-read the deposit AFTER the await, then check its status again - in
        // case, while waiting on the API above, this deposit was already marked
        // 'paid'/'expired' elsewhere (by a previous tick finishing late, say).
        const fresh = db.getDeposit(depositId);
        if (!fresh || fresh.status !== 'pending') return;
        const createdAtMs = new Date(fresh.createdAt).getTime();
        const match = transfers.find(tx =>
          Math.abs(tx.amount - fresh.usdtAmount) < 0.00005 &&
          tx.timestamp >= createdAtMs - 60000 && // 1 minute of tolerance for block clock skew
          !db.isTxHashUsed(tx.hash) // stop one on-chain tx crediting two deposits (see the isTxHashUsed comment in db.js)
        );
        if (match) {
          db.updateDeposit(depositId, { status: 'paid', paidAt: new Date().toISOString(), txHash: match.hash });
          clearInterval(timer);
          const newBalance = db.updateBalance(fresh.chatId, fresh.requestedAmount);
          triggerReferralRewardIfEligible(fresh.chatId); // PATCH v7: check and credit the referral reward if this is the user's first deposit
          bot.sendMessage(
            fresh.chatId,
            lang.t(fresh.chatId, 'usdt_paid', { hash: match.hash, amount: usd(fresh.requestedAmount, fresh.chatId), balance: usd(newBalance, fresh.chatId) }),
            { parse_mode: 'Markdown' }
          ).catch(() => {});
          // Automatic channel notification: "💳 New Wallet Top-Up!" (when the feature is on).
          sendChannelNotif('topup', buildChannelTopupText(fresh.chatId, 'usdt_bep20', fresh.requestedAmount));
          return;
        }
      } catch (err) {
        console.error(`USDT transfer check (${depositId}) error:`, err.message);
      }

      if (Date.now() > new Date(deposit.expiresAt).getTime()) {
        const fresh = db.getDeposit(depositId);
        if (!fresh || fresh.status !== 'pending') return;
        db.updateDeposit(depositId, { status: 'expired' });
        clearInterval(timer);
        bot.sendMessage(fresh.chatId, lang.t(fresh.chatId, 'usdt_expired', { id: depositId }), { parse_mode: 'Markdown' }).catch(() => {});
        // ===== BUG FIX (a safety net): a deposit that expired WITHOUT a match
        // used to just vanish quietly - so if the buyer HAD in fact transferred
        // on-chain (because the public RPC was down or lagging during the deposit
        // window, say - see the RANGE_BLOCKS notes in payment.js), nobody (no
        // admin) would know money had arrived without being credited. Admins now
        // get a notification every time this happens, including the unique amount
        // and wallet address, so they can check manually on a block explorer
        // (BscScan) and credit it by hand if it really was paid.
        notifyAdmins(
          `⚠️ <b>USDT BEP20 deposit expired (no match found)</b>\n\n` +
          `Deposit ID: <code>${escapeHtml(depositId)}</code>\n` +
          `User ID: ${escapeHtml(String(fresh.chatId))}\n` +
          `Nominal unik: <code>${escapeHtml(String(fresh.usdtAmount))} USDT</code>\n` +
          `Alamat: <code>${escapeHtml(fresh.walletAddress || '-')}</code>\n` +
          `Created: ${escapeHtml(fresh.createdAt)}\n\n` +
          `ℹ️ If the buyer claims they transferred, check manually on BscScan (a USDT transfer to the address above, the exact amount above, between the creation time and now). If you find a valid one, credit the user's balance manually.`
        );
      }
    } finally {
      busy = false;
    }
  }, USDT_POLL_INTERVAL_MS);
}

async function startTonTopup(chatId, usdAmount) {
  const rate = await payment.getTonToUsdRate(TON_TO_USD_RATE_FALLBACK);
  const baseTon = usdAmount / rate;
  const usedAmounts = db.getUsedTonAmounts();
  const uniqueAmount = payment.generateUniqueTonAmount(baseTon, usedAmounts);

  const deposit = db.createDeposit({
    chatId,
    method: 'ton',
    requestedAmount: usdAmount,
    expiresAt: new Date(Date.now() + TON_EXPIRE_MS).toISOString(),
    tonAmount: uniqueAmount,
    walletAddress: payment.TON_ADDRESS
  });

  const text = lang.t(chatId, 'ton_invoice_text', {
    min: usd(MIN_TOPUP_TON_AMOUNT, chatId),
    max: usd(MAX_TOPUP_AMOUNT, chatId),
    orderId: deposit.id,
    uniqueAmount,
    address: payment.TON_ADDRESS,
    // Per-line emoji come from teksEmoji() so the custom emoji an admin sets in
    // "🎨 Manage Emoji ID" -> "TON Deposit" take effect.
    title_icon: teksEmoji('ton_title', '💎'),
    min_icon: teksEmoji('ton_min', '🈷️'),
    max_icon: teksEmoji('ton_max', '🈷️'),
    address_icon: teksEmoji('ton_address_label', '🔺'),
    auto_icon: teksEmoji('ton_auto', '✅')
  });

  const replyMarkup = {
    inline_keyboard: [
      [withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_copy_address'), copy_text: { text: payment.TON_ADDRESS } }, 'copy_address_ton'), 'primary')],
      [withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_ton_cancel'), callback_data: `ton:cancel:${deposit.id}` }, 'batalkan_ton'), 'danger')]
    ]
  };

  const sentMsg = await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: replyMarkup });
  db.updateDeposit(deposit.id, { qrChatId: chatId, qrMessageId: sentMsg.message_id });
  pollTonDeposit(deposit.id);
}

function pollTonDeposit(depositId) {
  // See the "busy" comment in pollQrisDeposit()/pollUsdtDeposit().
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const deposit = db.getDeposit(depositId);
      if (!deposit || deposit.status !== 'pending') return clearInterval(timer);

      // ===== BUG FIX (the "paid but not credited" complaint): a match is ALWAYS
      // looked for on every tick before declaring expiry - see the fuller comment
      // in pollQrisDeposit().
      try {
        const transfers = await payment.fetchIncomingTonTransfers();
        const fresh = db.getDeposit(depositId);
        if (!fresh || fresh.status !== 'pending') return;
        const createdAtMs = new Date(fresh.createdAt).getTime();
        const match = transfers.find(tx =>
          Math.abs(tx.amount - fresh.tonAmount) < 0.000005 &&
          tx.timestamp >= createdAtMs - 60000 && // 1 minute of tolerance for block clock skew
          !db.isTxHashUsed(tx.hash) // stop one on-chain tx crediting two deposits (see the isTxHashUsed comment in db.js)
        );
        if (match) {
          db.updateDeposit(depositId, { status: 'paid', paidAt: new Date().toISOString(), txHash: match.hash });
          clearInterval(timer);
          const newBalance = db.updateBalance(fresh.chatId, fresh.requestedAmount);
          triggerReferralRewardIfEligible(fresh.chatId); // PATCH v7: check and credit the referral reward if this is the user's first deposit
          bot.sendMessage(
            fresh.chatId,
            lang.t(fresh.chatId, 'ton_paid', { amount: usd(fresh.requestedAmount, fresh.chatId), balance: usd(newBalance, fresh.chatId) }),
            { parse_mode: 'Markdown' }
          ).catch(() => {});
          // Automatic channel notification: "💳 New Wallet Top-Up!" (when the feature is on).
          sendChannelNotif('topup', buildChannelTopupText(fresh.chatId, 'ton', fresh.requestedAmount));
          return;
        }
      } catch (err) {
        console.error(`TON transfer check (${depositId}) error:`, err.message);
      }

      if (Date.now() > new Date(deposit.expiresAt).getTime()) {
        const fresh = db.getDeposit(depositId);
        if (!fresh || fresh.status !== 'pending') return;
        db.updateDeposit(depositId, { status: 'expired' });
        clearInterval(timer);
        bot.sendMessage(fresh.chatId, lang.t(fresh.chatId, 'ton_expired', { id: depositId }), { parse_mode: 'Markdown' }).catch(() => {});
        // The same safety net as in pollUsdtDeposit() - see the comment there.
        notifyAdmins(
          `⚠️ <b>TON deposit expired (no match found)</b>\n\n` +
          `Deposit ID: <code>${escapeHtml(depositId)}</code>\n` +
          `User ID: ${escapeHtml(String(fresh.chatId))}\n` +
          `Nominal unik: <code>${escapeHtml(String(fresh.tonAmount))} TON</code>\n` +
          `Alamat: <code>${escapeHtml(fresh.walletAddress || '-')}</code>\n` +
          `Created: ${escapeHtml(fresh.createdAt)}\n\n` +
          `ℹ️ If the buyer claims they transferred, check manually on a TON explorer. If you find a valid one, credit the user's balance manually.`
        );
      }
    } finally {
      busy = false;
    }
  }, TON_POLL_INTERVAL_MS);
}

async function startBinanceTopup(chatId, usdAmount) {
  // Binance Pay is pegged 1:1 to USD/USDT (the buyer transfers the amount in USDT
  // via the "Pay" menu in the Binance app), just like USDT BEP20 above.
  const baseAmount = usdAmount;
  const usedAmounts = db.getUsedBinanceAmounts();
  const uniqueAmount = payment.generateUniqueBinanceAmount(baseAmount, usedAmounts);

  const deposit = db.createDeposit({
    chatId,
    method: 'binance',
    requestedAmount: usdAmount,
    expiresAt: new Date(Date.now() + BINANCE_EXPIRE_MS).toISOString(),
    binanceAmount: uniqueAmount,
    binancePayId: BINANCE_PAY_ID
  });

  const text = lang.t(chatId, 'binance_invoice_text', {
    min: usd(MIN_TOPUP_BINANCE_AMOUNT, chatId),
    max: usd(MAX_TOPUP_AMOUNT, chatId),
    orderId: deposit.id,
    uniqueAmount,
    payId: BINANCE_PAY_ID,
    title_icon: teksEmoji('binance_title', '🟡'),
    min_icon: teksEmoji('binance_min', '🈷️'),
    max_icon: teksEmoji('binance_max', '🈷️'),
    payid_icon: teksEmoji('binance_payid_label', '🔺'),
    auto_icon: teksEmoji('binance_auto', '✅')
  });

  const replyMarkup = {
    inline_keyboard: [
      [withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_copy_binance_id'), copy_text: { text: BINANCE_PAY_ID } }, 'copy_id_binance'), 'primary')],
      [withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_binance_cancel'), callback_data: `binance:cancel:${deposit.id}` }, 'batalkan_binance'), 'danger')]
    ]
  };

  const sentMsg = await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: replyMarkup });
  db.updateDeposit(deposit.id, { qrChatId: chatId, qrMessageId: sentMsg.message_id });
  pollBinanceDeposit(deposit.id);
}

function pollBinanceDeposit(depositId) {
  // See the "busy" comment in pollQrisDeposit()/pollUsdtDeposit()/pollTonDeposit().
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const deposit = db.getDeposit(depositId);
      if (!deposit || deposit.status !== 'pending') return clearInterval(timer);

      // ===== BUG FIX (the "paid but not credited" complaint): a match is ALWAYS
      // looked for on every tick before declaring expiry - see the fuller comment
      // in pollQrisDeposit().
      try {
        const transactions = await payment.fetchIncomingBinancePayTransactions();
        // Re-read the deposit AFTER the await - see the same comment in pollUsdtDeposit().
        const fresh = db.getDeposit(depositId);
        if (!fresh || fresh.status !== 'pending') return;
        const createdAtMs = new Date(fresh.createdAt).getTime();
        // ===== BUG FIX (SECURITY - free credit): matching used to compare only
        // `tx.amount` (the raw number) and NEVER checked `tx.currency`. Binance
        // Pay C2C can send ANY ASSET the sender picks (USDT, BNB, SHIB, and so
        // on - not only USDT), and the invoice itself only says "send EXACTLY
        // this amount" without naming an asset. Because the unique amount is
        // built from an ordinary decimal number (5.0037, say), a BUYER COULD send
        // 5.0037 of a worthless asset (SHIB worth under a cent) instead of 5.0037
        // USDT worth $5 - the match would still "succeed" purely on the NUMBER,
        // and the buyer would get the FULL Wallet credit even though the actual
        // transfer was nearly worthless. The currency MUST now also match
        // BINANCE_EXPECTED_CURRENCY ('USDT') - a transfer of any other asset will
        // NEVER match, whatever the number.
        const match = transactions.find(tx =>
          tx.currency === payment.BINANCE_EXPECTED_CURRENCY &&
          Math.abs(tx.amount - fresh.binanceAmount) < 0.00005 &&
          tx.timestamp >= createdAtMs - 60000 && // 1 minute of tolerance
          !db.isTxHashUsed(`binance:${tx.id}`) // stop one Binance transaction crediting two deposits
        );
        if (match) {
          db.updateDeposit(depositId, { status: 'paid', paidAt: new Date().toISOString(), txHash: `binance:${match.id}` });
          clearInterval(timer);
          const newBalance = db.updateBalance(fresh.chatId, fresh.requestedAmount);
          triggerReferralRewardIfEligible(fresh.chatId); // PATCH v7: check and credit the referral reward if this is the user's first deposit
          bot.sendMessage(
            fresh.chatId,
            lang.t(fresh.chatId, 'binance_paid', { id: match.id, amount: usd(fresh.requestedAmount, fresh.chatId), balance: usd(newBalance, fresh.chatId) }),
            { parse_mode: 'Markdown' }
          ).catch(() => {});
          // Automatic channel notification: "💳 New Wallet Top-Up!" (when the feature is on).
          sendChannelNotif('topup', buildChannelTopupText(fresh.chatId, 'binance', fresh.requestedAmount));
          return;
        }
      } catch (err) {
        console.error(`Binance Pay history check (${depositId}) error:`, err.message);
      }

      if (Date.now() > new Date(deposit.expiresAt).getTime()) {
        const fresh = db.getDeposit(depositId);
        if (!fresh || fresh.status !== 'pending') return;
        db.updateDeposit(depositId, { status: 'expired' });
        clearInterval(timer);
        bot.sendMessage(fresh.chatId, lang.t(fresh.chatId, 'binance_expired', { id: depositId }), { parse_mode: 'Markdown' }).catch(() => {});
        // ⚠️ Diagnostic patch: this expiry notification used to say only "not
        // found", with nothing to work out WHY - forcing the admin to open the
        // Binance app manually. It now re-fetches the raw transactions (without
        // the strict currency/orderType filters) for this deposit's time window
        // and includes them in the notification when there are any - so it is
        // immediately obvious if, say, the currency was not USDT, the orderType
        // was not C2C, or the amount differed slightly from the one requested.
        let rawTxDetail = '';
        try {
          const rawTx = await payment.fetchRawBinancePayTransactionsInRange(
            new Date(fresh.createdAt).getTime() - 60000,
            new Date(fresh.expiresAt).getTime() + 60000
          );
          if (rawTx.length > 0) {
            const lines = rawTx.map(tx =>
              `• ${tx.amount} ${tx.currency || '?'} (orderType: ${tx.orderType || '?'}, id: ${tx.id})`
            ).join('\n');
            rawTxDetail = `\n\n<b>Binance Pay transactions in this time window (no automatic match, check manually):</b>\n${escapeHtml(lines)}`;
          } else {
            rawTxDetail = `\n\n<i>Tidak ada transaksi Binance Pay sama sekali di rentang waktu ini - kemungkinan buyer belum benar-benar transfer, salah kirim ke ID lain, atau transfer belum settle.</i>`;
          }
        } catch (rawErr) {
          rawTxDetail = `\n\n<i>Failed to fetch transaction diagnostics: ${escapeHtml(rawErr.message)}</i>`;
        }
        notifyAdmins(
          `⚠️ <b>Binance Pay deposit expired (no match found)</b>\n\n` +
          `Deposit ID: <code>${escapeHtml(depositId)}</code>\n` +
          `User ID: ${escapeHtml(String(fresh.chatId))}\n` +
          `Nominal unik: <code>${escapeHtml(String(fresh.binanceAmount))}</code>\n` +
          `Binance ID tujuan: <code>${escapeHtml(fresh.binancePayId || '-')}</code>\n` +
          `Dibuat: ${escapeHtml(fresh.createdAt)}` +
          rawTxDetail +
          `\n\nℹ️ If the buyer claims they transferred, check manually in the Binance app -> Pay -> History. If you find a valid one, credit the user's balance manually.`
        );
      }
    } finally {
      busy = false;
    }
  }, BINANCE_POLL_INTERVAL_MS);
}

// Keep monitoring every deposit still 'pending' when the bot restarts (after a
// code update or server reboot, say), so an unfinished topup is still detected
// automatically once the bot comes back up.
function resumePendingDeposits() {
  const pending = db.getPendingDeposits();
  pending.forEach(d => {
    if (d.method === 'qris') pollQrisDeposit(d.id);
    else if (d.method === 'usdt_bep20') pollUsdtDeposit(d.id);
    else if (d.method === 'ton') pollTonDeposit(d.id);
    else if (d.method === 'binance') pollBinanceDeposit(d.id);
  });
}

// There are 2 sources of premium custom emoji, with different mechanisms:
//
// 1) boltEmojiMenu() / boltEmojiText() -> a single ID hardcoded by hand in
//    emoji-id-teks.js, used for the bot's built-in "⚡" bullet: {e} in
//    descriptions/how-to-use, and in menu/notification text (welcome, order
//    success, and so on).
// 2) embedOwnerCustomEmoji() -> needs NO manual ID at all. When the OWNER (who
//    genuinely has Telegram Premium) types free text for a description/how-to-use
//    and PICKS a premium emoji straight from their own Telegram emoji panel
//    (rather than just typing plain unicode), Telegram automatically includes
//    that emoji's REAL custom_emoji_id in message.entities when the message
//    reaches the bot. The bot simply reads those entities and reinserts them as
//    <tg-emoji emoji-id="..."> tags, then stores it in the database as HTML - so
//    the moment the owner types it, that emoji becomes permanently premium in
//    that description/how-to-use, without touching any emoji-id file. (See its
//    use in the 'addproduct_desc' and 'sethowto_text' handlers under TEXT MESSAGES.)
//
// Per Bot API 9.4 (released 9 Feb 2026, core.telegram.org/bots/api-changelog#february-9-2026):
// a bot MAY send custom emoji in message text as long as the BOT OWNER's account
// (not the bot itself) has an active Telegram Premium subscription - via either
// mechanism (1) or (2) above. When the ID is empty or the owner is not Premium,
// it falls back to plain unicode automatically, with no error from Telegram.
// ID priority: (1) the "automatic capture" result from admin "🎨 Manage Emoji ID"
// (persisted in data/db.json), then (2) the static ID in emoji-id-teks.js.
const boltEmojiMenu = () => {
  const id = db.getEmojiId('teks:menu_notif') || BOLT_EMOJI_ID_MENU;
  return id ? `<tg-emoji emoji-id="${id}">⚡</tg-emoji>` : '⚡';
};
const boltEmojiText = () => {
  const id = db.getEmojiId('teks:product_desc') || BOLT_EMOJI_ID_TEXT;
  return id ? `<tg-emoji emoji-id="${id}">⚡</tg-emoji>` : '⚡';
};

// A GENERAL version of the mechanism above: used for ANY emoji inside message
// text (not just the "⚡" placeholder), where each key has its own slot under
// admin "🎨 Manage Emoji ID" -> "✍️ Emoji in Message Text". ID priority:
// (1) the "automatic capture" result in data/db.json, then (2) the static
// EMOJI_ID_TEKS_BACKUP fallback in emoji-id-teks.js. When both are empty it falls
// back to the plain unicode emoji (the second parameter), with NO ERROR.
function teksEmoji(key, fallback) {
  const id = db.getEmojiId(`teks:${key}`) || EMOJI_ID_TEKS_BACKUP[key];
  return id ? `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>` : fallback;
}

// The welcome text (/start) - used in several places, so it lives in one helper
// and only needs editing here. Each feature line has its own icon slot
// (teksEmoji) so it can be customised via admin "🎨 Manage Emoji ID" ->
// "✍️ Emoji in Message Text" -> "👋 Welcome Message (/start)".
function buildWelcomeText(chatId) {
  return `${teksEmoji('welcome_wave', '👋')} ${lang.t(chatId, 'welcome', {
    store: escapeHtml(STORE_NAME),
    cart_icon: teksEmoji('welcome_cart', '🛒'),
    wallet_icon: teksEmoji('welcome_wallet', '💳'),
    bolt_icon: teksEmoji('welcome_bolt', '⚡'),
    gift_icon: teksEmoji('welcome_gift', '🎁'),
    arrow_icon: teksEmoji('welcome_arrow', '👉')
  })}`;
}

// Maintenance Mode text (/admin -> 🛠️ Bot Maintenance). When the admin has set a
// CUSTOM message (via "✏️ Set Custom Message"), it is used as is (already
// including any <tg-emoji> tags from embedOwnerCustomEmoji() if the admin picked
// a premium emoji while typing - the same mechanism as Broadcast). When it is
// unset (null/empty), it falls back to the default "nice" text, whose icons all
// go through teksEmoji() -> automatically using the Premium emoji ALREADY in the
// file (borrowed from other slots, see the comments in emoji-id-teks.js), and
// still customisable via admin "🎨 Manage Emoji ID" -> "✍️ Emoji in Message
// Text" -> "🛠️ Maintenance Mode" WITHOUT touching any code.
function buildMaintenanceText(chatId) {
  const { message } = db.getMaintenanceSettings();
  if (message) return message;
  const title = lang.t(chatId, 'maintenance_title', {
    wrench_icon: teksEmoji('maintenance_wrench', '🛠️')
  });
  const desc = lang.t(chatId, 'maintenance_desc', {
    store: escapeHtml(STORE_NAME),
    sparkle_icon: teksEmoji('maintenance_sparkle', '✨'),
    bolt_icon: teksEmoji('maintenance_bolt', '⚡'),
    clock_icon: teksEmoji('maintenance_clock', '⏳'),
    heart_icon: teksEmoji('maintenance_heart', '🙏')
  });
  return `${title}\n\n${desc}`;
}

// The "Maintenance FINISHED" broadcast text - sent automatically to ALL users as
// soon as an admin turns Maintenance Mode off via "🔴 Disable" (see the
// 'maintenance_toggle' handler below). The same pattern as buildMaintenanceText()
// above: every icon goes through teksEmoji() so it automatically uses the Premium
// emoji ALREADY in the file (borrowed from other slots, see the notes in
// emoji-id-teks.js), and stays customisable via admin "🎨 Manage Emoji ID" ->
// "✍️ Emoji in Message Text" -> "🛠️ Maintenance Mode" WITHOUT touching any
// code. Unlike buildMaintenanceText(), this text ALWAYS uses the default
// template (never the admin's custom message), because it is a one-off send when
// maintenance has just finished, not a status shown repeatedly.
function buildMaintenanceFinishedText(chatId) {
  const title = lang.t(chatId, 'maintenance_finished_title', {
    rocket_icon: teksEmoji('maintenance_finished_rocket', '🚀')
  });
  const desc = lang.t(chatId, 'maintenance_finished_desc', {
    store: escapeHtml(STORE_NAME),
    sparkle_icon: teksEmoji('maintenance_finished_sparkle', '✨'),
    check_icon: teksEmoji('maintenance_finished_check', '✅'),
    bolt_icon: teksEmoji('maintenance_finished_bolt', '⚡'),
    gift_icon: teksEmoji('maintenance_finished_gift', '🎁'),
    heart_icon: teksEmoji('maintenance_finished_heart', '🙏')
  });
  return `${title}\n\n${desc}`;
}

// ================= FORCE JOIN CHANNEL/GROUP (Force Subscribe) =================
// Check whether a user has joined a channel OR group/supergroup via getChatMember
// - the mechanism is THE SAME for both; Telegram does not vary how membership is
// checked by chat type. chatRef may be an @username (a public channel/group) or a
// numeric chat id (required for a PRIVATE channel/group - the bot must be an
// admin there first to read the status). On any API error (the bot not being an
// admin, the channel/group having been deleted, etc.) the user is treated as NOT
// joined - safer than silently letting everyone through.
async function isUserMemberOfChannel(chatRef, userId) {
  try {
    const member = await bot.getChatMember(chatRef, userId);
    return ['creator', 'administrator', 'member'].includes(member.status);
  } catch (err) {
    console.error(`⚠️ Failed to check join status for channel ${chatRef}:`, err.message);
    return false;
  }
}

// Return the array of channels the user has NOT joined (a subset of all active
// force-join channels). An empty array means they have joined everything.
async function getUnjoinedChannels(userId) {
  const { enabled, channels } = db.getForceJoinSettings();
  if (!enabled || !channels.length) return [];
  const results = await Promise.all(
    channels.map(async ch => ({ ch, joined: await isUserMemberOfChannel(ch.chatRef, userId) }))
  );
  return results.filter(r => !r.joined).map(r => r.ch);
}

function forceJoinKeyboard(chatId, channels) {
  const rows = channels.map(ch => ([
    withButtonIcon({ text: lang.t(chatId, 'btn_join_channel', { title: ch.title }), url: ch.link }, 'join_channel')
  ]));
  rows.push([withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_checkjoin'), callback_data: 'checkjoin' }, 'checkjoin'), 'success')]);
  return { inline_keyboard: rows };
}

function forceJoinText(chatId, unjoinedChannels, allChannels) {
  const unjoinedIds = new Set(unjoinedChannels.map(c => c.id));
  const joinedIcon = teksEmoji('forcejoin_status_joined', '✅');
  const pendingIcon = teksEmoji('forcejoin_status_pending', '🔸');
  const lines = allChannels.map(ch => lang.t(chatId, 'forcejoin_channel_line', {
    status: unjoinedIds.has(ch.id) ? pendingIcon : joinedIcon,
    title: escapeHtml(ch.title)
  }));
  const title = lang.t(chatId, 'forcejoin_title', { lock_icon: teksEmoji('forcejoin_lock', '🔐') });
  const desc = lang.t(chatId, 'forcejoin_desc', {
    store: escapeHtml(STORE_NAME),
    lock_icon: teksEmoji('forcejoin_lock', '🔐'),
    sparkle_icon: teksEmoji('forcejoin_sparkle', '✨'),
    bolt_icon: teksEmoji('forcejoin_bolt', '⚡'),
    arrow_icon: teksEmoji('forcejoin_arrow', '👇'),
    check_icon: teksEmoji('forcejoin_check', '✅')
  });
  return `${title}\n\n${desc}\n\n${lines.join('\n')}`;
}

// The main gate: when the force-join feature is on and the user still has an
// unjoined channel, show the join screen (sending a new message OR editing the
// existing one, depending on `messageId`) and return false (the caller MUST stop
// there and not continue to the menu). Returns true when it is safe to continue
// (the feature is off, there are no channels, or the user has joined them all).
async function checkForceJoinAndPrompt(chatId, messageId) {
  const { enabled, channels } = db.getForceJoinSettings();
  if (!enabled || !channels.length) return true;
  const unjoined = await getUnjoinedChannels(chatId);
  if (!unjoined.length) return true;

  const text = forceJoinText(chatId, unjoined, channels);
  const keyboard = forceJoinKeyboard(chatId, channels);
  if (messageId) {
    await safeEditMessage(chatId, messageId, text, { parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
  return false;
}

// Take the message text EXACTLY as sent (msg.text, untrimmed) plus its entities,
// find the entities of type "custom_emoji" (which appear when the sender really
// picked a custom emoji from their Telegram Premium panel - as opposed to simply
// typing a plain unicode character), and reinsert them in place as
// <tg-emoji emoji-id="..."> tags. Processed from the end backwards (largest
// offset first) so that earlier entity offsets are not shifted by the tags just
// inserted. Telegram's offset/length are in UTF-16 code units, exactly matching
// JavaScript's native string representation, so the slicing below is safe to use
// directly with no extra conversion.
function embedOwnerCustomEmojiFrom(text, entities) {
  const raw = text || '';
  const customEmojiEntities = (entities || [])
    .filter(e => e.type === 'custom_emoji')
    .sort((a, b) => b.offset - a.offset);
  let result = raw;
  for (const ent of customEmojiEntities) {
    const start = ent.offset;
    const end = ent.offset + ent.length;
    const original = result.slice(start, end);
    result = result.slice(0, start) + `<tg-emoji emoji-id="${ent.custom_emoji_id}">${original}</tg-emoji>` + result.slice(end);
  }
  return result.trim();
}
function embedOwnerCustomEmoji(msg) {
  return embedOwnerCustomEmojiFrom(msg.text, msg.entities);
}

// Render a product description / how-to-use for display to the user: the only
// thing that needs replacing here is the legacy "{e}" placeholder. Other premium
// emoji the owner typed are already valid <tg-emoji> tags from the moment they
// were saved (via embedOwnerCustomEmoji() above), so they need no further
// processing - reprocessing them here could actually double-nest the tags.
const renderDescription = (text) => (text || '').split('{e}').join(boltEmojiText());

// Shared prompt shown on every admin "Set Description" screen.
const DESC_INPUT_PROMPT =
  'Type the new description (as many lines as you like; HTML tags such as `<b>...</b>` work for bold. ' +
  'If you pick a premium emoji straight from your own Telegram Premium panel, it is saved as premium ' +
  'automatically - no manual ID setup needed). Type `-` to clear it, or /cancel to abort.';

// Strip one unicode emoji (plus any following space) from the START of a text.
// Used once icon_custom_emoji_id is attached to a button, so the emoji does not
// appear TWICE - once as the button icon (custom, premium) and again as the plain
// unicode character still sitting in the label text.
// This regex covers basic emoji, emoji + variation selector (️), and emoji ZWJ
// sequences (👨‍👩‍👧 and friends) so the whole emoji cluster is removed rather
// than just part of it.
function stripLeadingEmoji(text) {
  return String(text || '').replace(
    /^\s*\p{Extended_Pictographic}(?:\uFE0F)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F)?)*\s*/u,
    ''
  );
}

// Attach an icon_custom_emoji_id to an inline keyboard button (Bot API 9.4+).
// "key" refers to one of the keys in the EMOJI_IDS object in
// emoji-id-menu-inline.js, so every button can have a DIFFERENT custom emoji
// icon, rather than a single ID shared by all of them. When the ID for that key
// is empty (or the owner is not Telegram Premium), the field is simply omitted ->
// the button renders normally without an icon, with no error from Telegram.
function withButtonIcon(button, key) {
  const id = iconFor(key);
  if (!id) return button;
  return { ...button, text: stripLeadingEmoji(button.text), icon_custom_emoji_id: id };
}

// Like withButtonIcon(), but PREFERRING the product's own premium emoji
// (product.emojiId - the Netflix/Spotify/Gemini logo the owner picked when
// creating that product, see productEmojiHtml()) when it has one, falling back to
// the global "key" ID (an ordinary "buy_now" button, say) when the product has no
// emojiId of its own. Used on buttons rendered PER PRODUCT (the "✅ Buy Now"
// button on the description page, "🛒 Order Now" in a channel notification) so
// the icon matches the app being bought, rather than one generic icon for every
// product.
function withButtonIconPreferProduct(button, key, product) {
  if (product && product.emojiId) {
    return { ...button, text: stripLeadingEmoji(button.text), icon_custom_emoji_id: product.emojiId };
  }
  return withButtonIcon(button, key);
}

// Give an inline keyboard button a background colour via the "style" field (Bot
// API 9.4+, released 9 Feb 2026). Valid values: 'primary' (blue), 'success'
// (green), 'danger' (red). When unset, Telegram uses the default transparent
// look. Unlike icon_custom_emoji_id, style does NOT require Telegram Premium at
// all - it works for every bot, so it is safe to use with no fallback.
function withStyle(button, style) {
  return { ...button, style };
}

// ===== PER-PRODUCT premium emoji (different again from the 2 mechanisms above) =====
// The source is NOT emoji-id-teks.js / emoji-id-menu-inline.js (which hold manual,
// global values per key), but the premium emoji the owner picks THEMSELVES
// straight from their Telegram Premium panel while typing the product name in the
// "➕ Add Product" flow (see the 'addproduct_name' handler). As soon as it is
// typed, Telegram supplies the REAL custom_emoji_id via message.entities -> that
// ID is stored per product as product.emojiId (plus product.emoji as the unicode
// fallback character). No manual ID needs entering in any file.

// For text with parse_mode 'HTML' -> render it as a real <tg-emoji> when the
// product has an emojiId, otherwise fall back to the plain unicode emoji / 📦.
function productEmojiHtml(product) {
  if (!product) return '📦';
  return product.emojiId
    ? `<tg-emoji emoji-id="${product.emojiId}">${product.emoji || '📦'}</tg-emoji>`
    : (product.emoji || '📦');
}

// For inline keyboard buttons -> the button text still uses the plain unicode
// emoji (Telegram cannot render a custom emoji INSIDE button text), but when the
// product has an emojiId it is also attached as the button ICON (Bot API 9.4+) so
// it still looks premium beside the text.
function withProductIcon(button, product) {
  return product && product.emojiId ? { ...button, icon_custom_emoji_id: product.emojiId } : button;
}

// ===== PER-GIFT premium emoji (🎁 Buy Gift / 💌 Confess Gift) =====
// Two different Telegram gifts (Snoop Cigar, Vintage Cigar, and so on) may well
// cost THE SAME (both 50⭐, say) while looking completely different - so the key
// is PER GIFT ID (g.id), NOT per star amount, so two different gifts that happen
// to cost the same can still have different icons.
//
// Icon ID priority (most preferred first):
//   1. A manual admin override via "🎁 Manage Gift Emoji" (db key
//      `gift:<giftId>`) - the most reliable, because many real Telegram gift
//      stickers are NOT registered as custom emoji (see giftStickerEmojiId() in
//      userbot.js), so live detection is often null.
//   2. The REAL custom_emoji_id from the gift's own sticker (live from Telegram,
//      when it happens to be registered as a custom emoji).
//   3. A fallback to the single global "gift" icon (emoji-id-menu-inline.js /
//      "🎨 Manage Emoji ID" -> the "🎁 Gift Selection Buttons" category).
// Returns null when all three are empty (the button/text renders normally without
// a premium icon, with no error).
function giftIconId(gift) {
  if (!gift) return null;
  return db.getEmojiId(`gift:${gift.id}`) || gift.emojiId || iconFor('gift') || null;
}

// For text with parse_mode 'HTML' -> render it as a real <tg-emoji> when the gift
// has an ID (via giftIconId()), otherwise fall back to a plain 🎁.
function giftEmojiHtml(gift) {
  const id = giftIconId(gift);
  return id ? `<tg-emoji emoji-id="${id}">🎁</tg-emoji>` : '🎁';
}

// Like withProductIcon() but for gifts - used on the "🎁 Buy Gift" / "💌 Confess
// Gift" list buttons so each gift can appear with an icon matching the real gift
// (rather than one generic icon for all of them).
function withGiftIcon(button, gift) {
  const id = giftIconId(gift);
  return id ? { ...button, icon_custom_emoji_id: id } : button;
}

// ===== PER-PRODUCT logo (the official Netflix/Spotify/Gemini logo, say) =====
// Set by the admin via /admin -> "🖼️ Set Product Logo" (an https image URL,
// stored as product.logoUrl). This is SEPARATE from the premium emoji (emojiId)
// above - the emoji still appears in text (via <tg-emoji>), while this logo is
// used as the IMAGE in channel notifications (sent via sendPhoto, with the
// caption still using the same HTML tags as ordinary text). When unset -> null,
// and the caller falls back automatically to a plain sendMessage (the emoji still
// showing normally), with no error or bug from here.
function productLogoUrl(product) {
  const url = product && product.logoUrl;
  return (typeof url === 'string' && /^https?:\/\//i.test(url.trim())) ? url.trim() : null;
}

// Safe to use inside parse_mode: 'HTML' (a redeem link entered by an admin may
// accidentally contain & < > characters -> they must be escaped first so Telegram
// does not reject the message and the bot does not error).
const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

// Send one (HTML) message to EVERY admin in ADMIN_IDS - used for notifications
// that are not an ordinary "new order" (a Supplier API order failure, say), so
// the ADMIN_IDS.forEach(...) pattern is not duplicated in many places.
function notifyAdmins(text) {
  ADMIN_IDS.forEach(adminId => {
    bot.sendMessage(adminId, text, { parse_mode: 'HTML' }).catch(() => {});
  });
}

// Send one (HTML) message to the same TELEGRAM GROUP used by the "💾 Auto Backup"
// feature (the Group ID in db.settings.backup.groupId, set via /admin ->
// 💾 Auto Backup -> change Group ID - see db.getBackupSettings()). Used for order
// notifications (a successful Buy Gift/Confess, say) that the admin wants pushed
// to the group rather than only as a private DM to ADMIN_IDS. It deliberately
// reuses the same group (rather than introducing a separate GROUP_ID) - the bot
// is already a member there for backups. It fails silently (is skipped) when no
// groupId has ever been set, so it never disrupts the main order flow.
function notifyOrderGroup(text) {
  const groupId = db.getBackupSettings().groupId;
  if (!groupId) return; // not set yet, skip quietly (the order still runs normally)
  bot.sendMessage(groupId, text, { parse_mode: 'HTML' }).catch(err => {
    logError('notifyOrderGroup', err); // so the log shows it if the bot is not a member / was kicked from the group
  });
}

// ===== Detecting a "supplier balance empty" error from an external API message =====
// Used so the buyer does NOT see the generic "stock unavailable" message
// (misleading - it implies the remote stock is empty) when the real cause is OUR
// STORE's wallet balance on the supplier's side (AIVerse Hub or Canboso) being
// empty or not yet topped up. It is detected from the keywords commonly used in
// error messages like this (balance/saldo/insufficient/top up/fund and so on) -
// WITHOUT ever naming the supplier brand to the buyer (see supplier_balance_empty
// in lang.js), because buyers do not need to know which supplier is used behind
// the scenes.
function isSupplierBalanceError(message) {
  if (!message) return false;
  const m = String(message).toLowerCase();
  const balanceWord = /(balance|saldo|wallet|fund|dana)/.test(m);
  const emptyWord = /(insufficient|not enough|tidak cukup|kurang|habis|empty|low|belum.*top.?up|top.?up dulu)/.test(m);
  return balanceWord && emptyWord;
}

// ===== BUG FIX: alert admins when the Canboso live stock FAILS to parse =====
// Previously, when canboso.getLiveStock() returned stock = NaN (the stock field
// name in Canboso's response not yet recognised by pick() in supplierCanboso.js)
// or the product was no longer found on Canboso, the bot only called
// console.error() - NOBODY told the admin. As a result the local variant.stock
// (0 from the moment it was linked, say) was never updated again, buyers always
// saw "Available stock: 0" even though stock really did exist on Canboso, and the
// admin only noticed if they happened to open 🔄 Refresh Price & Stock manually.
// An alert is now sent automatically the first time a buyer hits this condition,
// with a 30-minute cooldown PER variant so admins are not spammed every time a
// buyer opens the same product page.
const canbosoStockAlertCooldown = new Map(); // canbosoProductId -> timestamp of the last alert
function alertCanbosoStockIssue(variant, reason) {
  const key = String(variant.canbosoProductId);
  const now = Date.now();
  const last = canbosoStockAlertCooldown.get(key) || 0;
  if (now - last < 30 * 60 * 1000) return; // still within the cooldown, skip
  canbosoStockAlertCooldown.set(key, now);
  notifyAdmins(
    `⚠️ <b>Canboso live stock failed to sync</b>\n\n` +
    `Product ID: <code>${escapeHtml(key)}</code>\n` +
    `Alasan: ${escapeHtml(reason)}\n\n` +
    `Buyers will keep seeing the old LOCAL stock (which may be wrong or stale) until this is fixed. ` +
    `Check <b>/admin → 🔌 Canboso API → 🐞 View Raw Response</b> to see the stock field name Canboso actually uses, then add it to the candidate list in supplierCanboso.js.`
  );
}

// ===== Bug fix: the raw response diagnostic used to be truncated by a long field
// ("description", say) before ever reaching the price/stock fields - so the admin
// never actually saw the field name they were looking for. It is now condensed
// into a "key=value" list per field (rather than a full JSON.stringify), with
// long string values (>40 chars, such as description) truncated so short fields
// like price/stock/qty are still included and do not fall past Telegram's message
// length limit.
function describeRawFields(raw, maxLen = 600) {
  if (!raw || typeof raw !== 'object') return String(raw);
  const parts = [];
  for (const [k, v] of Object.entries(raw)) {
    let vStr;
    if (v && typeof v === 'object') vStr = JSON.stringify(v).slice(0, 60);
    else vStr = String(v);
    if (vStr.length > 40) vStr = vStr.slice(0, 40) + '…';
    parts.push(`${k}=${vStr}`);
  }
  const joined = parts.join(' | ');
  return joined.length > maxLen ? joined.slice(0, maxLen) + '…' : joined;
}

// ================= AUTOMATIC CHANNEL NOTIFICATIONS =================
// Feature: /admin -> 📢 Set Channel Notifications. On every successful product
// purchase OR successful Wallet topup (QRIS/USDT/TON), the bot automatically
// sends one text message plus an inline menu to the destination channel/group the
// admin configured (data/db.json -> settings.channelNotif). Every icon in this
// message MUST use a premium custom emoji that already exists (via
// teksEmoji()/withButtonIcon() - ID priority from admin "🎨 Manage Emoji ID",
// falling back to an ID already used on another page - see the "channelnotif_*"
// group comments in emoji-id-teks.js), not a new ID that may never have been
// captured. Admins can still change any emoji here at any time via "🎨 Manage
// Emoji ID" -> "✍️ Emoji in Message Text" -> "📢 Channel Notifications".

// Mask part of an ID (a user's chatId / Order ID / Deposit ID) before showing it
// in a PUBLIC channel - so there is still an identifying trace (for the admin's
// manual verification) without leaking a user's full ID publicly. For example:
// "6148372901107" -> "6148***107". When an ID is too short to truncate safely
// (7 characters or fewer), it is shown as is.
function maskChannelId(raw) {
  const str = String(raw);
  if (str.length <= 7) return str;
  return `${str.slice(0, 4)}***${str.slice(-3)}`;
}

// Format a time in WIB (Asia/Jakarta) as "31-Aug-2026 01:41 AM WIB" - used
// specifically in channel notifications so they are consistent and easy for the
// public to read, separate from the other date formats in the bot.
function formatChannelTime() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
  }).formatToParts(now);
  const get = (t) => (parts.find(p => p.type === t) || {}).value || '';
  return `${get('day')}-${get('month')}-${get('year')} ${get('hour')}:${get('minute')} ${get('dayPeriod')} WIB`;
}

// The inline menu attached to EVERY channel notification (both New Purchase and
// New Wallet Top-Up) - a call to action for people watching the channel: order
// now / contact the admin. Both buttons are hidden automatically when the data
// they need is not set in .env (BOT_USERNAME / ADMIN_IDS).
// "product" is optional - when supplied (a 'purchase' notification) AND that
// product has its own emojiId, the "Order Now" button icon uses THAT PRODUCT's
// premium emoji (matching the app just bought) rather than a generic 🛒 icon.
function channelNotifKeyboard(product) {
  const row = [];
  if (BOT_USERNAME) {
    row.push(withStyle(withButtonIconPreferProduct({ text: '🛒 Order Now', url: `https://t.me/${BOT_USERNAME}` }, 'buy_now', product), 'primary'));
  }
  const ownerId = ADMIN_IDS && ADMIN_IDS[0];
  if (ownerId) {
    row.push(withStyle(withButtonIcon({ text: '💬 Contact Admin', url: `tg://user?id=${ownerId}` }, 'contact_support'), 'primary'));
  }
  return row.length ? { inline_keyboard: [row] } : undefined;
}

// The "🎉 New Purchase!" text - sent after a successful order (auto-delivery OR
// manual, it makes no difference - the channel only shows a transaction summary).
function buildChannelPurchaseText(chatId, product, variant, qty, total) {
  const border = teksEmoji('channelnotif_border', '✨');
  const line = `${border}━━━━━━━━━━${border}`;
  const title = teksEmoji('channelnotif_purchase_title', '🎉');
  const footer = teksEmoji('channelnotif_footer', '🔥');
  return (
    `${line}\n` +
    `${title} <b>NEW PURCHASE!</b> ${title}\n` +
    `${line}\n\n` +
    `<blockquote>` +
    `${teksEmoji('channelnotif_id', '📌')} <b>ID:</b> <code>${maskChannelId(chatId)}</code>\n` +
    `${teksEmoji('channelnotif_product', '🛒')} <b>Product:</b> ${productEmojiHtml(product)} ${escapeHtml(product.name)} - ${escapeHtml(variant.label)}\n` +
    `${teksEmoji('channelnotif_qty', '⭐️')} <b>Quantity:</b> ${qty}\n` +
    `${teksEmoji('channelnotif_total', '💰')} <b>Total:</b> ${usd(total)}\n` +
    `${teksEmoji('channelnotif_time', '🕒')} <b>Time:</b> ${formatChannelTime()}` +
    `</blockquote>\n\n` +
    `${footer} <i>${escapeHtml(STORE_NAME)} — Fast &amp; Trusted!</i>`
  );
}

// The "💳 New Wallet Top-Up!" text - sent after a successful Wallet deposit
// (QRIS / USDT BEP20 / TON), with the network label derived from the method.
function buildChannelTopupText(chatId, method, amount) {
  const border = teksEmoji('channelnotif_border', '✨');
  const line = `${border}━━━━━━━━━━${border}`;
  const title = teksEmoji('channelnotif_topup_title', '💳');
  const footer = teksEmoji('channelnotif_footer', '🔥');
  const networkLabel = method === 'usdt_bep20' ? 'BSC (USDT BEP20)'
    : method === 'ton' ? 'TON'
    : method === 'binance' ? 'Binance Pay'
    : 'QRIS';
  return (
    `${line}\n` +
    `${title} <b>NEW WALLET TOP-UP!</b> ${title}\n` +
    `${line}\n\n` +
    `<blockquote>` +
    `${teksEmoji('channelnotif_id', '📌')} <b>ID:</b> <code>${maskChannelId(chatId)}</code>\n` +
    `${teksEmoji('channelnotif_network', '✅')} <b>Network:</b> ${networkLabel}\n` +
    `${teksEmoji('channelnotif_amount', '💵')} <b>Amount:</b> ${usd(amount)}\n` +
    `${teksEmoji('channelnotif_time', '🕒')} <b>Time:</b> ${formatChannelTime()}` +
    `</blockquote>\n\n` +
    `${footer} <i>${escapeHtml(STORE_NAME)} — Instant &amp; Automatic!</i>`
  );
}

// Format a referral reward as "+$0.0500" (4 decimals plus a "+" sign) - used
// SPECIFICALLY in referral channel notifications so a reward amount, usually small
// ($0.05, say), still reads precisely and clearly as money coming IN (not a
// deduction). The value always comes STRAIGHT from REFERRAL_REWARD in .env, so it
// follows automatically when an admin changes it.
//
// NOTE: a "USDT" suffix is deliberately NOT added - this reward increases the
// store's internal WALLET BALANCE (the generic "$" unit used everywhere else in
// the bot), NOT a real USDT token transfer. That balance itself can be funded
// from QRIS/USDT BEP20/TON alike, so a "USDT" label here could make channel
// members think they received actual USDT crypto when it is only store credit.
// If a real token-based reward is ever used, change the suffix below to suit.
function formatReferralReward(amount) {
  return `+$${Number(amount).toFixed(4)}`;
}

// ===== PATCH v7: the referral reward trigger - called from the 4 successful
// deposit confirmation points (QRIS/USDT/TON/Binance) after the user's balance
// is credited, rather than directly from /start (see db.registerReferral() and
// db.creditReferralOnFirstDeposit() for the full explanation of why it moved).
// Safe to call for EVERY successful deposit - the db function itself ensures the
// reward is granted only ONCE (on the first deposit), so callers need no checks.
function triggerReferralRewardIfEligible(newUserChatId) {
  const result = db.creditReferralOnFirstDeposit(newUserChatId, REFERRAL_REWARD);
  if (!result) return;
  bot.sendMessage(
    result.referrerChatId,
    lang.t(result.referrerChatId, 'referral_success', { amount: usd(REFERRAL_REWARD, result.referrerChatId), balance: usd(result.newBalance, result.referrerChatId) }),
    { parse_mode: 'HTML' }
  ).catch(() => {});
  sendChannelNotif('referral', buildChannelReferralText(newUserChatId, result.referrerChatId, REFERRAL_REWARD));
}

// The "🎉 New Referral Success!" text - sent whenever a referral reward is
// credited SUCCESSFULLY (see triggerReferralRewardIfEligible() above), which is
// when an invited user REALLY tops up their balance for the first time.
// Both the user and the referrer are shown as masked IDs (see maskChannelId) so
// there is still a verification trace without leaking full IDs publicly. The
// reward shown is REFERRAL_REWARD from .env.
function buildChannelReferralText(newUserChatId, referrerChatId, reward) {
  const border = teksEmoji('channelnotif_border', '✨');
  const line = `${border}━━━━━━━━━━${border}`;
  const title = teksEmoji('channelnotif_referral_title', '🎉');
  const footer = teksEmoji('channelnotif_footer', '🔥');
  return (
    `${line}\n` +
    `${title} <b>NEW REFERRAL SUCCESS!</b> ${title}\n` +
    `${line}\n\n` +
    `<blockquote>` +
    `${teksEmoji('channelnotif_referral_user', '👤')} <b>User:</b> <code>${maskChannelId(newUserChatId)}</code>\n` +
    `${teksEmoji('channelnotif_referral_referredby', '🎁')} <b>Referred by:</b> <code>${maskChannelId(referrerChatId)}</code>\n` +
    `${teksEmoji('channelnotif_referral_reward', '💵')} <b>Reward:</b> ${formatReferralReward(reward)}\n` +
    `${teksEmoji('channelnotif_time', '🕒')} <b>Time:</b> ${formatChannelTime()}` +
    `</blockquote>\n\n` +
    `${footer} <i>${escapeHtml(STORE_NAME)} — Refer &amp; Earn!</i>`
  );
}

// The "🛠️ MAINTENANCE STARTED!" / "🚀 MAINTENANCE FINISHED!" channel
// notification text - sent to the destination channel/group (settings.channelNotif)
// whenever an admin enables or disables Maintenance Mode (see the
// 'maintenance_toggle' handler below), so channel members know without opening the
// bot. status: 'start' | 'finish'.
function buildChannelMaintenanceText(status) {
  const border = teksEmoji('channelnotif_border', '✨');
  const line = `${border}━━━━━━━━━━${border}`;
  const footer = teksEmoji('channelnotif_footer', '🔥');
  const isStart = status === 'start';
  const title = isStart
    ? teksEmoji('channelnotif_maintenance_start_title', '🛠️')
    : teksEmoji('channelnotif_maintenance_finish_title', '🚀');
  const titleText = isStart ? 'MAINTENANCE STARTED!' : 'MAINTENANCE FINISHED!';
  const statusIcon = isStart
    ? teksEmoji('channelnotif_maintenance_start_status', '⏳')
    : teksEmoji('channelnotif_maintenance_finish_status', '✅');
  const statusLabel = isStart
    ? 'The bot is temporarily unavailable to users while it is being upgraded'
    : 'The bot is back to normal, every feature is usable again';
  return (
    `${line}\n` +
    `${title} <b>${titleText}</b> ${title}\n` +
    `${line}\n\n` +
    `<blockquote>` +
    `${statusIcon} <b>Status:</b> ${statusLabel}\n` +
    `${teksEmoji('channelnotif_time', '🕒')} <b>Time:</b> ${formatChannelTime()}` +
    `</blockquote>\n\n` +
    `${footer} <i>${escapeHtml(STORE_NAME)}</i>`
  );
}

// Send one notification message to the destination channel (when the feature is
// on and chatRef is set). kind: 'purchase' | 'topup' | 'referral' - checked
// against the notifyPurchase/notifyTopup/notifyReferral toggles respectively, so
// an admin can turn off one kind of notification without disabling them all.
// A send failure (the bot not yet being an admin in the channel, say) is only
// logged and must NEVER disrupt the main flow (the user must still get their
// product/balance/reward even if the channel notification fails).
// "product" is optional - when supplied AND that product has a logoUrl (see
// productLogoUrl() above), the notification is sent as a PHOTO (the real app logo,
// Netflix/Spotify/Gemini and so on) with the text as its caption (still HTML, so
// premium <tg-emoji> tags and <b>/<code> render exactly as in ordinary text).
// Telegram caps captions at 1024 characters (unlike ordinary text at 4096) - when
// the text is too long for a caption, it falls back automatically to an ordinary
// text message WITHOUT the logo, so it never fails because of that limit. And if
// the logoUrl turns out to be broken or unreachable, sendPhoto also falls back to
// sendMessage - so the notification IS delivered in both cases, with no error
// that could make it vanish entirely.
function sendChannelNotif(kind, text, product) {
  const settings = db.getChannelNotifSettings();
  if (!settings.enabled || !settings.chatRef) return;
  if (kind === 'purchase' && !settings.notifyPurchase) return;
  if (kind === 'topup' && !settings.notifyTopup) return;
  if (kind === 'referral' && !settings.notifyReferral) return;
  if (kind === 'maintenance' && !settings.notifyMaintenance) return;
  const logoUrl = productLogoUrl(product);
  const keyboard = channelNotifKeyboard(product);
  const sendAsText = () => bot.sendMessage(settings.chatRef, text, { parse_mode: 'HTML', reply_markup: keyboard })
    .catch(err => console.error('Failed to send the channel notification:', err.message));
  if (logoUrl && text.length <= 1024) {
    bot.sendPhoto(settings.chatRef, logoUrl, { caption: text, parse_mode: 'HTML', reply_markup: keyboard })
      .catch(err => {
        console.error('Failed to send the channel notification (logo photo), falling back to plain text:', err.message);
        sendAsText();
      });
  } else {
    sendAsText();
  }
}

// Format one stock item for display (to buyers and admins alike). An item can
// take 2 forms, distinguished by the "|" separator:
//   - A plain link/code (no "|")                 -> shown as is
//   - An account combo "email|password|2fa|link" -> shown neatly field by field
// The combo field positions are ALWAYS fixed (Email, Password, 2FA Code, Link)
// following STOCK_COMBO_LABELS below - when there is no 2FA code, its segment
// must still be left EMPTY between two "|" marks ("email|password||link"), NOT
// removed, so that "link" is not shifted into the "2FA Code" position. Lines
// whose segment is empty are automatically hidden from the buyer.
//
// The 2FA Code field (index 2) is special: when its content is a base32 TOTP
// secret (the same format used by https://2fa.cn/ and Google Authenticator -
// spaces and lowercase allowed), the bot COMPUTES the currently valid 6-digit
// code ITSELF (live, not static) using the standard TOTP algorithm (RFC 6238) in
// totp.js - producing exactly what 2fa.cn shows for the same secret. When the
// content is not a secret (an old-style static digit code, say), it is shown as
// is, as before.
const STOCK_COMBO_LABELS = ['📧 Email', '🔑 Password', '🔐 2FA Code', '🔗 Link'];
function formatStockItem(raw, index, chatId) {
  const num = index != null ? `${index + 1}. ` : '';
  const str = String(raw);
  if (!str.includes('|')) {
    return `${num}${escapeHtml(str)}`;
  }
  const parts = str.split('|').map(s => s.trim());
  const fieldLines = parts
    .map((val, i) => ({ label: STOCK_COMBO_LABELS[i] || `Field ${i + 1}`, val, isTotpField: i === 2 }))
    .filter(f => f.val !== '')
    .map(f => {
      if (f.isTotpField && totp.looksLikeTotpSecret(f.val)) {
        const code = totp.generateTOTP(f.val);
        const sisa = totp.secondsRemaining();
        return code
          ? `    ${f.label}: <code>${code}</code>  ${lang.t(chatId, 'live_totp_note', { seconds: sisa })}`
          : `    ${f.label}: <code>${escapeHtml(f.val)}</code>`;
      }
      return `    ${f.label}: <code>${escapeHtml(f.val)}</code>`;
    })
    .join('\n');
  if (!fieldLines) {
    return `${num}${escapeHtml(str)}`;
  }
  return `${num}<b>${lang.t(chatId, 'account_label')}:</b>\n${fieldLines}`;
}

// Check whether any item in deliveredItems has a 2FA Code field holding a TOTP
// secret (rather than a static code) - used to decide whether to show the
// "🔄 Refresh 2FA Code" button, since the code changes every 30 seconds.
function hasLiveTotpSecret(deliveredItems) {
  if (!deliveredItems || !deliveredItems.length) return false;
  return deliveredItems.some(raw => {
    const parts = String(raw).split('|');
    return parts.length > 2 && totp.looksLikeTotpSecret(parts[2]);
  });
}

// Build the full-premium "Order Successful" text and attach the product (redeem
// links and so on) when it is available from auto-delivery stock.
function buildSuccessText(product, variant, qty, total, orderId, deliveredItems, chatId) {
  const bolt = boltEmojiMenu();
  const border = teksEmoji('success_border', '✨');
  const line = `${border}━━━━━━━━━━${border}`;
  let text =
    `${line}\n` +
    `${teksEmoji('success_title', '🎉')} ${lang.t(chatId, 'success_title')} ${teksEmoji('success_title', '🎉')}\n` +
    `${line}\n\n` +
    `${bolt} ${lang.t(chatId, 'success_product_label')} ${productEmojiHtml(product)} ${escapeHtml(product.name)} - ${escapeHtml(variant.label)}\n` +
    `${bolt} ${lang.t(chatId, 'success_qty_label')} ${lang.t(chatId, 'success_qty_unit', { qty })}\n` +
    `${bolt} ${lang.t(chatId, 'success_total_label')} ${usd(total, chatId)}\n` +
    `${bolt} ${lang.t(chatId, 'success_orderid_label')} <code>${orderId}</code>\n\n`;

  if (deliveredItems && deliveredItems.length) {
    text +=
      `${teksEmoji('success_delivered', '🚀')} ${lang.t(chatId, 'success_delivered_title')}\n\n` +
      `${teksEmoji('success_link', '🔗')} ${lang.t(chatId, 'success_delivered_detail')}\n` +
      deliveredItems.map((item, i) => formatStockItem(item, i, chatId)).join('\n\n') +
      `\n\n`;
  } else {
    text += `${teksEmoji('success_manual', '📦')} ${lang.t(chatId, 'success_manual')}\n\n`;
  }

  text += `${teksEmoji('success_thanks', '🙏')} ${lang.t(chatId, 'success_thanks', { store: escapeHtml(STORE_NAME) })} ${bolt}`;
  return text;
}

// Format one auto-delivery audit log entry - used by admin:deliverylog (the
// recent list) and admin:checkorder (looking up one specific order by ID).
function formatDeliveryLogEntry(order) {
  const product = db.findProduct(order.productId);
  const variant = product && product.variants.find(v => v.id === order.variantId);
  const productLabel = product && variant ? `${product.name} - ${variant.label}` : `${order.productId}/${order.variantId}`;
  const who = order.username ? `@${escapeHtml(order.username)}` : `ID ${order.chatId}`;
  const when = new Date(order.createdAt).toLocaleString('id-ID');

  let text =
    `🧾 <b>Order</b> <code>${escapeHtml(order.id)}</code>\n` +
    `👤 User: ${who} (${order.chatId})\n` +
    `📦 ${escapeHtml(productLabel)} x${order.qty}\n` +
    `🕒 ${when}\n`;

  if (order.delivered && order.deliveredItems && order.deliveredItems.length) {
    text += `🔗 Item terkirim:\n` + order.deliveredItems.map((item, i) => formatStockItem(item, i)).join('\n\n');
  } else {
    text += `📦 Sent manually by an admin (not auto-delivery).`;
  }
  return text;
}

// ================= MENU BUILDERS =================

function mainMenuKeyboard(chatId) {
  // The main menu is laid out in 2 full columns (rather than one button per row),
  // so it is more compact and takes less scrolling on a phone screen.
  return {
    inline_keyboard: [
      [
        withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_buy_product'), callback_data: 'menu:products' }, 'buy_produk'), 'primary'),
        withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_profile'), callback_data: 'menu:profile' }, 'profile'), 'primary')
      ],
      [
        withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_balance'), callback_data: 'menu:balance' }, 'saldo_saya'), 'primary'),
        withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_wallet'), callback_data: 'menu:topup' }, 'topup'), 'primary')
      ],
      [
        withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_orders'), callback_data: 'menu:history' }, 'riwayat_pembelian'), 'primary'),
        withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_howto'), callback_data: 'menu:howtouse' }, 'how_to_use'), 'primary')
      ],
      [
        withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_support'), callback_data: 'menu:support' }, 'support'), 'primary'),
        withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_referral'), callback_data: 'menu:referral' }, 'referral'), 'success')
      ],
      [
        withStyle({ text: lang.t(chatId, 'btn_gift_menu'), callback_data: 'gift:mode' }, 'success')
      ]
    ]
  };
}

// ================= GIFT (Buy Gift / Confess Gift, via the GramJS userbot) =================
// mode: 'buy'     -> the gift is sent on behalf of the userbot account, with NO message.
//       'confess' -> the gift plus an anonymous message typed by the buyer, with
//                    the sender's identity hidden (hideName: true in userbot.js).

// Gift sale price = cost (stars x rate) + markup%. The rate and markup CAN be
// overridden live by an admin via the "💲 Set Gift Pricing" menu
// (db.settings.giftPricing, see db.js) - when never set (still null), the
// defaults from .env are used (GIFT_MARKUP_PCT / STARS_TO_USD_RATE in config.js).
function giftPriceUsd(stars) {
  const pricing = db.getGiftPricingSettings();
  const rate = pricing.starsToUsdRate != null ? pricing.starsToUsdRate : STARS_TO_USD_RATE;
  const markupPct = pricing.markupPct != null ? pricing.markupPct : GIFT_MARKUP_PCT;
  const modal = stars * rate;
  return modal * (1 + markupPct / 100);
}

// A grid of 3 columns per row (rather than a single column as before) - tidier
// and fitting more on screen without long scrolling, mirroring the usual Telegram
// gift shop layout. The button text no longer carries a 🎁 emoji before the
// price - the gift icon is already represented by icon_custom_emoji_id
// (withGiftIcon()), so a generic 🎁 in the text would only duplicate it and crowd
// a small button. Limited gifts get the 'success' style (green) so they stand out
// from regular gifts (default/no style - transparent, following the client theme).
// cols defaults to 2 (not 3) - with 3 columns, a small phone screen truncates the
// price text ("Rp5.000" becoming just "Rp5"). 2 columns give each button enough
// width for the full price to show.
function giftGridRows(items, buttonForItem, cols = 2) {
  const rows = [];
  let row = [];
  items.forEach((item, idx) => {
    row.push(buttonForItem(item));
    if (row.length === cols || idx === items.length - 1) {
      rows.push(row);
      row = [];
    }
  });
  return rows;
}

async function giftListKeyboard(chatId, mode) {
  const rows = [];
  try {
    const catalog = await userbot.getGiftCatalog();
    const items = catalog.slice(0, 30);
    const gridRows = giftGridRows(items, g => {
      const priceLabel = usd(giftPriceUsd(g.stars), chatId);
      // The button icon uses giftIconId() - priority: a manual per-gift admin
      // override ("🎁 Manage Gift Emoji") > the REAL custom_emoji_id from the
      // gift's own sticker (when Telegram happens to expose it) > a single global
      // "gift" fallback icon. See the full comment on giftIconId().
      const button = { text: `${priceLabel}`, callback_data: `gift:pick:${mode}:${g.id}` };
      const withIcon = withGiftIcon(button, g);
      return g.limited ? withStyle(withIcon, 'success') : withIcon;
    });
    rows.push(...gridRows);
  } catch (err) {
    logError('giftListKeyboard', err);
  }
  rows.push([withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_back'), callback_data: 'gift:mode' }, 'back'), 'danger')]);
  return { inline_keyboard: rows };
}

function giftListText(chatId, mode) {
  return mode === 'confess'
    ? lang.t(chatId, 'gift_list_title_confess')
    : lang.t(chatId, 'gift_list_title_buy');
}

async function giftDetailText(chatId, gift, mode) {
  const priceLabel = usd(giftPriceUsd(gift.stars), chatId);
  const emojiHtml = giftEmojiHtml(gift);
  return (
    `${emojiHtml} <b>Gift ${gift.stars}⭐</b>\n` +
    `${lang.t(chatId, 'gift_detail_price_line', { price: priceLabel })}\n\n` +
    lang.t(chatId, 'gift_ask_target')
  );
}

function giftCancelKeyboard(chatId) {
  return { inline_keyboard: [[withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_cancel_arrow'), callback_data: 'menu:main' }, 'batal'), 'danger')]] };
}

// Show the final confirmation screen (price, target, and a message preview for
// confess) before the balance is deducted and the gift actually sent. A random
// confirmToken is used so the "✅ Send" button below is valid only for THIS one
// active pending action (it is not the real orderId - the order is created in the
// 'gift:confirm:' handler after this button is pressed).
async function showGiftConfirmation(chatId, { mode, giftId, stars, target, message }) {
  const priceUsd = giftPriceUsd(stars);
  const confirmToken = crypto.randomBytes(6).toString('hex');
  db.setPendingAction(chatId, { type: 'gift_confirm', data: { mode, giftId, stars, target, message, priceUsd, confirmToken } });

  const modeLabel = mode === 'confess' ? lang.t(chatId, 'btn_gift_confess') : lang.t(chatId, 'btn_gift_buy');
  const lines = [
    lang.t(chatId, 'gift_confirm_title', { mode: modeLabel }),
    lang.t(chatId, 'gift_confirm_gift_line', { stars }),
    lang.t(chatId, 'gift_detail_price_line', { price: usd(priceUsd, chatId) }),
    lang.t(chatId, 'gift_confirm_target_line', { target: escapeHtml(target) })
  ];
  if (mode === 'confess' && message) {
    lines.push(lang.t(chatId, 'gift_confirm_message_line', { message: escapeHtml(message) }));
  }
  lines.push('', lang.t(chatId, 'gift_confirm_hidden_notice'));

  await bot.sendMessage(chatId, lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [withStyle({ text: lang.t(chatId, 'btn_gift_send_now'), callback_data: `gift:confirm:${confirmToken}` }, 'success')],
        [withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_cancel_arrow'), callback_data: 'menu:main' }, 'batal'), 'danger')]
      ]
    }
  });
}

// Notify ALL admins when the userbot's Stars balance drops below the threshold
// (GIFT_LOW_STARS_THRESHOLD). It has a 6-hour cooldown so admins are NOT spammed
// with the same notification on every new gift order while the Stars have yet to
// be topped up (rather than re-notifying per order, once per period is plenty).
let lastLowStarsNotifyAt = 0;
const LOW_STARS_NOTIFY_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

async function maybeNotifyLowStars(chatIdForLangFallback) {
  try {
    const stars = await userbot.getUserbotStarsBalance();
    if (stars >= GIFT_LOW_STARS_THRESHOLD) return;
    const now = Date.now();
    if (now - lastLowStarsNotifyAt < LOW_STARS_NOTIFY_COOLDOWN_MS) return;
    lastLowStarsNotifyAt = now;

    const text = `⚠️ <b>The userbot's Stars balance is running low!</b>\n\n🌟 Remaining: ${stars}⭐ (threshold: ${GIFT_LOW_STARS_THRESHOLD}⭐)\n\nBuyers may start hitting "Stars out of stock" on 🎁 Buy Gift / 💌 Confess Gift orders. Top up soon via Settings > Stars on the userbot account.`;
    for (const adminId of ADMIN_IDS) {
      bot.sendMessage(adminId, text, { parse_mode: 'HTML' }).catch(err => logError('maybeNotifyLowStars', err));
    }
  } catch (err) {
    logError('maybeNotifyLowStars check', err);
  }
}

// Send the gift (called after the buyer confirms and the balance has already been
// deducted up front). On failure the balance is REFUNDED automatically - a buyer
// never loses out because of a technical failure (target not found, gift sold out,
// and so on).
// Admins ALWAYS get a notification per order (both success and failure-refund).
async function executeGiftSend(chatId, order) {
  const who = order.username ? `@${escapeHtml(order.username)}` : `ID ${order.chatId}`;
  const modeLabel = order.mode === 'confess' ? '💌 Confess Gift' : '🎁 Buy Gift';

  // ===== BUG FIX (a "lost" success notification to the group + a double refund):
  // PREVIOUSLY the gift send AND the notification steps (the message to the buyer,
  // the admin notification, the group notification) sat inside THE SAME try/catch.
  // If the gift HAD been sent successfully but sending the confirmation message to
  // the buyer failed (the buyer blocking the bot / a deactivated account / "chat
  // not found"), that exception was caught by the same catch block -> an order
  // that had ALREADY SUCCEEDED was wrongly marked 'failed_refunded', the buyer got
  // a DOUBLE REFUND (the gift plus their balance back), and the success
  // notification to the admin/GROUP was NEVER sent - a "FAILED" notice went out
  // instead. The gift send (which decides success/failure and refunding) is now
  // COMPLETELY separated from the notification steps that follow - a notification
  // failure can never again change the status of an order that already succeeded.
  let sendError = null;
  try {
    await userbot.sendGiftToUser({
      targetUsernameOrId: order.target,
      giftId: order.giftId,
      message: order.mode === 'confess' ? order.message : undefined,
      hideName: true
    });
  } catch (err) {
    sendError = err;
  }

  if (!sendError) {
    db.updateGiftOrder(order.id, { status: 'sent' });
    maybeNotifyLowStars(chatId); // check and alert admins if Stars run low (non-blocking)
    // The .catch(() => {}) is deliberate - failing to notify the BUYER must not be
    // treated as an ORDER failure (the gift has definitely been sent).
    bot.sendMessage(chatId,
      `✅ Gift sent successfully to <b>${escapeHtml(order.target)}</b>!\n` +
      `🧾 Order ID: <code>${order.id}</code>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
    notifyAdmins(
      `${modeLabel} - <b>SUCCESSFUL</b>\n\n` +
      `👤 Buyer: ${who} (${order.chatId})\n` +
      `🎁 Gift ID: <code>${escapeHtml(String(order.giftId))}</code> (${order.stars} Stars)\n` +
      `🎯 Target: <code>${escapeHtml(order.target)}</code>\n` +
      `💰 Price: ${usd(order.priceUsd)}\n` +
      (order.mode === 'confess' && order.message ? `💬 Message: ${escapeHtml(order.message)}\n` : '') +
      `🧾 Order ID: <code>${order.id}</code>`
    );
    // As requested: the GROUP notification is ONLY for SUCCESSFUL "Buy Gift"
    // orders (mode !== 'confess'). Confess Gift is NOT sent to the group (so its
    // anonymous message is never exposed there), and FAILED orders are NOT sent to
    // the group either (the admin DM above is enough).
    if (order.mode !== 'confess') {
      notifyOrderGroup(
        `${modeLabel} - <b>SUCCESSFUL</b> ✅\n\n` +
        `👤 Buyer: ${who}\n` +
        `🎁 Gift ID: <code>${escapeHtml(String(order.giftId))}</code> (${order.stars} Stars)\n` +
        `🎯 Target: <code>${escapeHtml(order.target)}</code>\n` +
        `💰 Price: ${usd(order.priceUsd)}\n` +
        `🧾 Order ID: <code>${order.id}</code>`
      );
    }
  } else {
    const err = sendError;
    logError('executeGiftSend', err);
    // Automatic refund - THIS IS MANDATORY; never let a buyer's balance vanish
    // because a gift send failed.
    db.updateBalance(chatId, order.priceUsd);
    db.updateGiftOrder(order.id, { status: 'failed_refunded', error: String(err.message || err) });
    bot.sendMessage(chatId,
      `❌ The gift could not be sent (${escapeHtml(String(err.message || err))}).\n` +
      `💰 Your <b>${usd(order.priceUsd, chatId)}</b> has been refunded automatically to your wallet.`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
    notifyAdmins(
      `${modeLabel} - <b>FAILED (automatic refund)</b>\n\n` +
      `👤 Buyer: ${who} (${order.chatId})\n` +
      `🎁 Gift ID: <code>${escapeHtml(String(order.giftId))}</code> (${order.stars} Stars)\n` +
      `🎯 Target: <code>${escapeHtml(order.target)}</code>\n` +
      `💰 Price (refunded): ${usd(order.priceUsd)}\n` +
      `🧾 Order ID: <code>${order.id}</code>\n` +
      `❌ Error: ${escapeHtml(String(err.message || err))}`
    );
    // As requested: FAILED orders are not sent to the group (only the admin DM
    // above) - the group is only for SUCCESSFUL Buy Gift orders.
  }
}

// A user's personal referral link, in Telegram's standard /start deep-link format
// (https://t.me/<bot_username>?start=<payload>). The payload used here is the
// inviter's own chatId, so that when an invited friend opens the bot through this
// link, the /start handler immediately knows who invited them.
function referralLink(chatId) {
  return `https://t.me/${BOT_USERNAME}?start=${chatId}`;
}

function profileText(chatId, from) {
  const user = db.getUser(chatId, from && from.username);
  const orders = db.getOrdersByUser(chatId);
  const stats = db.getReferralStats(chatId);
  const displayName = (from && (from.first_name || from.username)) || 'User';
  const usernameLine = user.username ? `@${escapeHtml(user.username)}` : lang.t(chatId, 'profile_username_empty');

  return (
    `${teksEmoji('profile_title', '👤')} <b>${lang.t(chatId, 'profile_title').replace(/^👤\s*/, '')}</b>\n\n` +
    `${teksEmoji('profile_nama', '🙍')} <b>${lang.t(chatId, 'profile_name')}:</b> ${escapeHtml(displayName)}\n` +
    `${teksEmoji('profile_username', '🔖')} <b>${lang.t(chatId, 'profile_username')}:</b> ${usernameLine}\n` +
    `${teksEmoji('profile_chatid', '🆔')} <b>${lang.t(chatId, 'profile_chatid')}:</b> <code>${chatId}</code>\n\n` +
    `${teksEmoji('profile_saldo', '💰')} <b>${lang.t(chatId, 'profile_balance')}:</b> ${usd(user.balance, chatId)}\n` +
    `${teksEmoji('profile_order', '🧾')} <b>${lang.t(chatId, 'profile_orders')}:</b> ${orders.length}\n` +
    `${teksEmoji('profile_referral', '🎁')} <b>${lang.t(chatId, 'profile_referral')}:</b> ${stats.referralCount} (${usd(stats.referralEarnings, chatId)})`
  );
}

function profileKeyboard(chatId) {
  return {
    inline_keyboard: [
      [
        withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_wallet'), callback_data: 'menu:topup' }, 'topup'), 'primary'),
        withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_orders'), callback_data: 'menu:history' }, 'riwayat_pembelian'), 'primary')
      ],
      [withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_back'), callback_data: 'menu:main' }, 'back'), 'danger')]
    ]
  };
}

function supportKeyboard(chatId) {
  const ownerId = ADMIN_IDS && ADMIN_IDS[0];
  const rows = [];
  if (ownerId) {
    rows.push([withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_contact_support'), url: `tg://user?id=${ownerId}` }, 'contact_support'), 'primary')]);
  }
  rows.push([withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_back'), callback_data: 'menu:main' }, 'back'), 'danger')]);
  return { inline_keyboard: rows };
}

function referralKeyboard(chatId) {
  const rows = [
    [withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_share_referral'), url: `https://t.me/share/url?url=${encodeURIComponent(referralLink(chatId))}&text=${encodeURIComponent(`Yuk belanja akun premium murah di ${STORE_NAME}!`)}` }, 'share_referral'), 'primary')]
  ];
  if (BOT_USERNAME) {
    // Telegram's built-in copy_text button (Bot API 7.x+) - one press copies the
    // referral link STRAIGHT to the user's clipboard, WITHOUT the bot sending a
    // new message containing it.
    rows.push([withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_copy_referral'), copy_text: { text: referralLink(chatId) } }, 'copy_referral'), 'primary')]);
  } else {
    // BOT_USERNAME is not set -> the link is not valid yet, so still offer a button
    // that raises a warning via callback (rather than a static, wrong copy_text).
    rows.push([withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_copy_referral'), callback_data: 'referral:copy' }, 'copy_referral'), 'primary')]);
  }
  rows.push([withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_back'), callback_data: 'menu:main' }, 'back'), 'danger')]);
  return { inline_keyboard: rows };
}

function referralText(chatId) {
  const stats = db.getReferralStats(chatId);
  // Page title: its emoji comes from teksEmoji() so a custom emoji set by the admin
  // under "🎨 Manage Emoji ID" -> "Refer & Earn Page" applies. When unset it falls
  // back to the plain unicode emoji automatically.
  const title = `${teksEmoji('referral_title', '🎁')} ${lang.t(chatId, 'referral_title')}`;
  if (!BOT_USERNAME) {
    return `${title}\n\n${lang.t(chatId, 'referral_disabled')}`;
  }
  return `${title}\n\n` + lang.t(chatId, 'referral_body', {
    store: STORE_NAME,
    reward: usd(REFERRAL_REWARD, chatId),
    link: referralLink(chatId),
    count: stats.referralCount,
    earnings: usd(stats.referralEarnings, chatId),
    // Same as the title: each line uses its own emoji key (matching the keys in the
    // admin menu: referral_reward, referral_link, referral_howitworks,
    // referral_total, referral_earnings).
    reward_emoji: teksEmoji('referral_reward', '💎'),
    link_emoji: teksEmoji('referral_link', '🔗'),
    how_emoji: teksEmoji('referral_howitworks', '💳'),
    total_emoji: teksEmoji('referral_total', '👥'),
    earnings_emoji: teksEmoji('referral_earnings', '💰')
  });
}

// A stock label that is safe to show a buyer. Since Supplier API variant stock is
// synced automatically by scheduleSupplierSync(), the variant.stock number is
// already live - so it is simply shown as is with an icon in front, telling the
// buyer this stock is supplied automatically through an API (rather than being
// manual admin stock), instead of the generic indicator used before.
// ===== BUG FIX: BUTTON_DATA_INVALID for products/variants with long names =====
// Many buttons (desc/howto/variant/qty/qtycustom/confirm) used to embed the
// productId+variantId VERBATIM into callback_data, for example
// `variant:${productId}:${variantId}`. Telegram caps callback_data HARD at 64
// bytes - and for a product with a long name ("Netflix 1M Premium 4K HDR" -> id
// "netflix-1m-premium-4k-hdr", variant id "...-default") that limit is easily
// exceeded. When it is, Telegram REJECTS the entire message carrying that
// keyboard (a "BUTTON_DATA_INVALID" error), so the buyer only gets a generic
// error when opening that product's description page - while other products with
// shorter names (Gemini, Spotify) work fine.
// (successKeyboard() above hit EXACTLY THE SAME problem and was fixed the same
// way - store a short reference, not the raw id.)
//
// The fix: replace the raw productId+variantId with a short 10-character hash
// that ALWAYS fits however long the product name is, then resolve it back to the
// real productId/variantId via resolveProductRef() when the button is pressed.
// This store's product catalogue is small, so a full loop on resolve is cheap and
// needs no extra index or cache.
function productRef(productId, variantId) {
  return crypto.createHash('sha1').update(`${productId}\u0000${variantId}`).digest('hex').slice(0, 10);
}

function resolveProductRef(ref) {
  for (const p of db.getAllProducts()) {
    for (const v of p.variants) {
      if (productRef(p.id, v.id) === ref) return { productId: p.id, variantId: v.id };
    }
  }
  return null;
}

function stockLabel(variant) {
  // BUG FIX: this used to always show the static text "Auto (API)" whatever the
  // real stock was, because a Supplier API variant's local stock was only
  // refreshed manually (and often forgotten). variant.liveStock is now synced
  // automatically every SUPPLIER_SYNC_INTERVAL_MINUTES by scheduleSupplierSync(),
  // so this number is live and safe to show a buyer directly.
  // Canboso API variants are NOW also checked live whenever a buyer opens the
  // variant page (see the 'variant:' handler) - their variant.liveStock is synced
  // there, so the number here is fresh enough to display as is (no longer a
  // generic "Auto (API)" label).
  // ===== PATCH: live stock (variant.liveStock) and manual stock (variant.stock,
  // mirrored from stockItems.length) are now SEPARATE fields (see
  // db.setVariantStock) - so both must be ADDED TOGETHER here via
  // db.getTotalStock(), so the number shown reflects the total that can genuinely
  // be fulfilled (live + manual), not just one of them.
  return String(db.getTotalStock(variant));
}

// Flat list of every SKU (product + variant) as its own buy button, color-coded by stock
// ===== PATCH v3: live-check Canboso API variants before computing the colour =====
// The button colour (green/red) here used to rely purely on db.getTotalStock(v),
// a LOCAL number updated only by the scheduled sync (scheduleCanbosoSync, every
// CANBOSO_SYNC_INTERVAL_SECONDS) or the 30-second repaint
// (scheduleProductListRepaint) - both of which merely RECOMPUTE from that SAME
// local number rather than refreshing it. As a result there was a window where a
// button was still green while the stock on Canboso's side had already hit 0
// (just taken by another buyer), until the buyer pressed "Buy Now" and only then
// saw "Out of stock" - see the 'variant:' handler, which already had a similar
// live check. productListKeyboard() is now ASYNC and fetches live stock for every
// variant with a canbosoProductId, EXACTLY the pattern used in the 'variant:'
// handler (via canboso.getLiveStock(), already cached for 20 seconds at the
// supplierCanboso.js level -> getProductsCached(), so it adds no API load when
// called repeatedly within 20 seconds by many buyers or the repaint timer).
// When a fetch fails or times out, DO NOT block - fall back silently to the
// existing local number (db.getTotalStock(v)), following the same principle as
// elsewhere: this live check only freshens the display, it is NOT the final
// validation (placeOrder() in the 'confirm:' handler remains that).
// Supplier API (AIVerse Hub) is deliberately excluded here - its module
// (supplier.js) has no cache layer like Canboso's getProductsCached(), so a live
// check on every menu open could be heavier and more rate-limit prone. For
// Supplier API variants, shorten SUPPLIER_SYNC_INTERVAL_MINUTES in .env if you
// want a smaller staleness window.
async function productListKeyboard(chatId) {
  const products = db.getAllProducts();
  const rows = [];
  for (const p of products) {
    for (const v of p.variants) {
      if (v.canbosoProductId) {
        try {
          const live = await canboso.getLiveStock(v.canbosoProductId);
          if (live && !isNaN(live.stock)) {
            db.setVariantStock(p.id, v.id, live.stock);
            v.liveStock = live.stock;
          }
          // When live is null/NaN (the product vanished from Canboso / the field
          // is unrecognised), stay quiet here - alertCanbosoStockIssue() is
          // already triggered elsewhere (the 'variant:' handler / scheduled sync),
          // so there is no need to double-alert every time the list menu opens.
        } catch (err) {
          // The fetch failed (network/API down/timeout) - use the last known local
          // number, and never let an error here stop the whole product menu from
          // rendering.
          console.error(`Canboso getLiveStock (list) failed (product_id=${v.canbosoProductId}):`, err.message);
        }
      }
      const label = p.variants.length > 1 ? `${p.name} ${v.label}` : p.name;
      // When a product has an emojiId, its emoji already appears as the button
      // icon (icon_custom_emoji_id) -> do not repeat p.emoji in the label text, or
      // it would show twice.
      const emojiPart = p.emojiId ? '' : (p.emoji ? `${p.emoji} ` : '');
      // ===== PATCH v2: real button colours (the Bot API 9.4 "style" field) =====
      // This used to prepend a 🟢/🔴 dot to the label text, because Telegram was
      // believed not to support colouring an inline button's BACKGROUND. It does
      // - exactly the mechanism already used by the /start menu buttons (see
      // withStyle(), style 'primary'/'success'/'danger').
      // It is now used here too: stock > 0 -> 'success' (genuinely green), out of
      // stock -> 'danger' (genuinely red) - the text dot emoji was removed as
      // redundant next to the button's own background colour.
      const stockStyle = db.getTotalStock(v) > 0 ? 'success' : 'danger';
      rows.push([withStyle(withProductIcon({
        text: `${emojiPart}${label} - ${usd(db.getBulkPrice(v), chatId)} | Stock: ${stockLabel(v)}`,
        callback_data: `desc:${productRef(p.id, v.id)}`
      }, p), stockStyle)]);
    }
  }
  rows.push([withButtonIcon({ text: lang.t(chatId, 'btn_go_back'), callback_data: 'menu:main' }, 'go_back')]);
  return { inline_keyboard: rows };
}

// ===== PATCH v3: the "Buy Now" button colour on the detail page follows stock =====
// This button used to be a neutral grey whatever the stock was - unlike the
// product list (productListKeyboard), which was already coloured green/red. The
// effect was that a buyer only learned a product was sold out AFTER pressing
// "Buy Now" (getting an "Out of stock" alert), when it should have been visible
// from the button colour the moment the detail page opened. It now takes a
// `variant` parameter (optional, for backward compatibility with any caller not
// yet updated) - when supplied, the "Buy Now" button is coloured
// 'success'/'danger' exactly as in productListKeyboard().
function descKeyboard(productId, variantId, chatId, product, variant) {
  const ref = productRef(productId, variantId);
  const buyButton = withButtonIconPreferProduct({ text: lang.t(chatId, 'btn_buy_now'), callback_data: `variant:${ref}` }, 'buy_now', product);
  const buyRow = variant ? [withStyle(buyButton, db.getTotalStock(variant) > 0 ? 'success' : 'danger')] : [buyButton];
  return {
    inline_keyboard: [
      [withButtonIcon({ text: lang.t(chatId, 'btn_how_to_use'), callback_data: `howto:${ref}` }, 'how_to_use')],
      buyRow,
      [withButtonIcon({ text: lang.t(chatId, 'btn_back'), callback_data: 'menu:products' }, 'back')]
    ]
  };
}

// ===== FEATURE: 🔔 Live Stock Notification to ALL Users =====
// Triggered AUTOMATICALLY whenever an admin successfully adds stock to a variant,
// by any route (📋 pasting links/codes -> addstock_items, OR 🔢 a manual number
// -> addstock_manual_qty - see both handlers in the TEXT MESSAGES section).
// Every icon in this text has its own slot via teksEmoji() (the "stockalert"
// group in TEKS_GROUPS) - so it ALWAYS uses a Premium custom emoji once the admin
// fills in the ID via "🎨 Manage Emoji ID" (falling back to plain unicode when
// unset or the owner is not Premium, the same as every other mechanism in this
// bot - it never errors).
function buildStockAlertText(product, variant, qtyAdded, chatId) {
  const title = product.variants.length > 1 ? `${product.name} - ${variant.label}` : product.name;
  return (
    `${teksEmoji('stockalert_bell', '🔔')} <b>NEW STOCK AVAILABLE!</b>\n\n` +
    `${teksEmoji('stockalert_product', '📦')} <b>Product:</b> ${productEmojiHtml(product)} ${escapeHtml(title)}\n` +
    `${teksEmoji('stockalert_added', '➕')} <b>Added:</b> ${qtyAdded} pcs\n` +
    `${teksEmoji('stockalert_total', '📊')} <b>Total Stock Now:</b> ${db.getTotalStock(variant)} pcs\n` +
    `${teksEmoji('stockalert_price', '💲')} <b>Price:</b> ${usd(db.getBasePrice(variant), chatId)}\n\n` +
    `${teksEmoji('stockalert_footer', '⚡')} Check out now before it sells out again!`
  );
}

// The "✅ Buy Now" button attached to a live stock notification - it PREFERS the
// product's own premium emoji (like descKeyboard() above), and links straight to
// the SAME `variant:${ref}` callback used by the Buy Now button on the product
// description page (see the `data.startsWith('variant:')` handler) - so pressing
// it goes directly into the choose-quantity flow, rather than merely reopening
// the description page.
function stockAlertKeyboard(productId, variantId, product) {
  const ref = productRef(productId, variantId);
  return {
    inline_keyboard: [
      [withStyle(withButtonIconPreferProduct({ text: '✅ Buy Now', callback_data: `variant:${ref}` }, 'buy_now', product), 'success')]
    ]
  };
}

// A generic broadcast to ALL registered users (exactly the pattern used by 📢
// Broadcast/Maintenance Mode: a one-by-one loop with a small delay between
// messages to stay under Telegram's rate limit). buildTextForUser(uid) is called
// PER user so prices can be personalised. The keyboard is the same for everyone.
// adminChatId is optional - when supplied, a success/failure summary is sent back
// there once it finishes.
async function broadcastToAllUsers(buildTextForUser, keyboard, adminChatId, label) {
  const allDb = db.readDb();
  const userIds = Object.keys(allDb.users);
  let success = 0, failed = 0;
  for (const uid of userIds) {
    try {
      await bot.sendMessage(uid, buildTextForUser(uid), { parse_mode: 'HTML', reply_markup: keyboard });
      success++;
    } catch (err) {
      failed++; // usually the user has blocked or deleted the bot - move on to the next
    }
    await new Promise(r => setTimeout(r, 40));
  }
  if (adminChatId) {
    bot.sendMessage(adminChatId,
      `🔔 <i>${escapeHtml(label)} finished sending to all users.</i>\n📨 Succeeded: <b>${success}</b> • ⚠️ Failed: <b>${failed}</b>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }
}

// Broadcast a live stock notification to ALL registered users as soon as an admin
// adds stock manually (📥 Add Stock - see addstock_items/addstock_manual_qty).
// It is DELIBERATELY not awaited by its caller - so an admin adding stock
// (especially when pasting many links at once, one message per line) does not
// have to wait for the broadcast to finish before sending the next line. The
// success/failure summary is sent back to the admin who triggered it
// (adminChatId) once the broadcast completes.
async function broadcastStockAlert(product, variant, qtyAdded, adminChatId) {
  const keyboard = stockAlertKeyboard(product.id, variant.id, product);
  await broadcastToAllUsers(
    uid => buildStockAlertText(product, variant, qtyAdded, uid),
    keyboard, adminChatId, `Live stock notification (${product.name})`
  );
}

// ===== FEATURE: 🔔 Live Stock Notification from a Supplier/Canboso SYNC =====
// Unlike broadcastStockAlert() above (triggered by an admin adding stock
// MANUALLY), this fires AUTOMATICALLY whenever a scheduled auto-sync
// (scheduleSupplierSync()/scheduleCanbosoSync() - see refreshSupplierData/
// refreshCanbosoData below) detects that the TOTAL stock of one or more variants
// has changed (up OR down) since the previous sync - as requested: sent on every
// sync, not only on a restock from 0. Every variant that changed within the SAME
// sync cycle is combined into ONE broadcast message (rather than a separate
// message per variant) so users are not flooded when many variants change at
// once.
function buildStockSyncBroadcastText(changes, chatId) {
  const bell = teksEmoji('stockalert_bell', '🔔');
  const footer = teksEmoji('stockalert_footer', '⚡');
  const blocks = changes.map(c => {
    const title = c.product.variants.length > 1 ? `${c.product.name} - ${c.variant.label}` : c.product.name;
    const arrow = c.newTotal > c.oldTotal ? '📈' : '📉';
    return (
      `${productEmojiHtml(c.product)} <b>${escapeHtml(title)}</b>\n` +
      `${teksEmoji('stockalert_total', '📊')} Stok: ${c.oldTotal} → <b>${c.newTotal}</b> pcs ${arrow}\n` +
      `${teksEmoji('stockalert_price', '💲')} ${usd(db.getBasePrice(c.variant), chatId)}`
    );
  });
  return `${bell} <b>STOCK UPDATED (Live Supplier)!</b>\n\n${blocks.join('\n\n')}\n\n${footer} Take a look and check out now!`;
}

function stockSyncBroadcastKeyboard(changes) {
  const rows = changes.map(c => ([
    withStyle(withButtonIconPreferProduct({
      text: `✅ Buy Now - ${c.product.variants.length > 1 ? c.variant.label : c.product.name}`,
      callback_data: `variant:${productRef(c.product.id, c.variant.id)}`
    }, 'buy_now', c.product), 'success')
  ]));
  return { inline_keyboard: rows };
}

// Called fire-and-forget from scheduleSupplierSync()/scheduleCanbosoSync() -
// there is NO adminChatId (it is automatic, not triggered by an admin from chat),
// so no summary goes back to an admin here (avoiding duplicate spam - sync errors
// relevant to admins already have their own route via notifyAdmins() in
// scheduleSupplierSync/scheduleCanbosoSync).
async function broadcastStockSyncChanges(changes) {
  if (!changes || !changes.length) return;
  const keyboard = stockSyncBroadcastKeyboard(changes);
  await broadcastToAllUsers(uid => buildStockSyncBroadcastText(changes, uid), keyboard, null, 'Live stock notification (supplier sync)');
}

function howToListKeyboard(chatId) {
  const products = db.getAllProducts();
  const rows = [];
  products.forEach(p => {
    p.variants.forEach(v => {
      const label = p.variants.length > 1 ? `${p.name} ${v.label}` : p.name;
      const emojiPart = p.emojiId ? '' : (p.emoji ? `${p.emoji} ` : '');
      rows.push([withProductIcon({
        text: `${emojiPart}${label}`,
        callback_data: `howto:${productRef(p.id, v.id)}:list`
      }, p)]);
    });
  });
  rows.push([withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_close_menu'), callback_data: 'howtouse:close' }, 'close_menu'), 'danger')]);
  return { inline_keyboard: rows };
}

// The keyboard for the "ORDER SUCCESSFUL" message - How to Use is always there,
// and when an item carries a TOTP secret (a live 2FA code) a Refresh button is
// added, because the code changes every 30 seconds and a static one goes stale.
function successKeyboard(productId, variantId, orderId, deliveredItems, chatId) {
  // IMPORTANT: this button carries only the orderId ("howtoorder:<orderId>"), NOT
  // productId+variantId+orderId together. productId/variantId are easily long
  // (variant.id often already contains product.id as a prefix), and Telegram caps
  // callback_data at 64 bytes - combining all three easily exceeds that and makes
  // Telegram REJECT the entire "ORDER SUCCESSFUL" message (see the .catch(() => {})
  // in the caller, so the buyer would silently get no order message at all if that
  // happened).
  // The 'howtoorder:' handler below reads productId/variantId from the stored
  // order data, the same pattern as the existing "backtoorder:".
  const rows = [
    [withButtonIcon({ text: '❗️ How to Use', callback_data: `howtoorder:${orderId}` }, 'how_to_use')]
  ];
  if (hasLiveTotpSecret(deliveredItems)) {
    rows.push([withButtonIcon({ text: lang.t(chatId, 'btn_refresh_2fa'), callback_data: `refresh2fa:${orderId}` }, 'refresh_2fa')]);
  }
  return { inline_keyboard: rows };
}

function howToKeyboard(productId, variantId, context, chatId) {
  // The back button returns to wherever "How to Use" was pressed from:
  // - context 'list'  -> back to the main "How to Use" menu (from the main menu)
  // - context ord_xxx -> back to the original "ORDER SUCCESSFUL" message
  // - empty           -> back to the product description page (from "Buy Now")
  let backCallback;
  if (context === 'list') backCallback = 'menu:howtouse';
  else if (context) backCallback = `backtoorder:${context}`;
  else backCallback = `desc:${productRef(productId, variantId)}`;
  return {
    inline_keyboard: [
      [withButtonIcon({ text: lang.t(chatId, 'btn_back'), callback_data: backCallback }, 'back')]
    ]
  };
}

// The 🎉/✅ icons in the "Bulk Discount" block below USED TO be plain unicode
// hardcoded straight into lang.js (bulk_discount_title/bulk_discount_line) - so
// they could NEVER render as premium even though other icons on the same page
// (⚠️/📦 in enter_qty_title) already did. Both now go through teksEmoji() as
// well, BORROWING IDs that already exist and are already used elsewhere (not new
// ones) so the style stays consistent: 🎉 borrows from 'success_title' (the
// "ORDER SUCCESSFUL" heading), ✅ borrows from 'forcejoin_check' (the force-join
// tick) - either can still be changed separately at any time via admin
// "🎨 Manage Emoji ID" -> "✍️ Emoji in Message Text" if the owner wants.
function tiersText(variant, chatId) {
  if (!variant.tiers || variant.tiers.length <= 1) {
    return lang.t(chatId, 'price_per_pcs', { price: usd(db.getBasePrice(variant), chatId) });
  }
  const lines = variant.tiers.map(t => {
    const range = t.max === null ? `${t.min}+` : `${t.min} - ${t.max}`;
    return lang.t(chatId, 'bulk_discount_line', { range, price: usd(t.price, chatId), emoji_check: teksEmoji('bulk_check', '✅') });
  });
  return `${lang.t(chatId, 'bulk_discount_title', { emoji_title: teksEmoji('bulk_title', '🎉') })}\n${lines.join('\n')}`;
}

function quantityKeyboard(productId, variantId, chatId) {
  const ref = productRef(productId, variantId);
  const quicks = [1, 5, 10, 20, 30, 50, 100];
  const rows = [];
  for (let i = 0; i < quicks.length; i += 4) {
    rows.push(quicks.slice(i, i + 4).map(n => ({
      text: String(n), callback_data: `qty:${ref}:${n}`
    })));
  }
  rows.push([withButtonIcon({ text: lang.t(chatId, 'qty_custom'), callback_data: `qtycustom:${ref}` }, 'jumlah_custom')]);
  rows.push([withButtonIcon({ text: lang.t(chatId, 'btn_back'), callback_data: `desc:${ref}` }, 'back')]);
  return { inline_keyboard: rows };
}

// The quick-topup button row (QRIS/USDT/TON) for a given USD amount - used in 2
// places by product decision: (1) directly on the Order Confirmation page when
// the balance is short, and (2) in the follow-up message when a user presses
// "Place Order" but the balance is still short. The amount travels in
// callback_data as CENTS (an integer) - not a decimal - so there is no rounding
// or float-parsing trouble in callback data, which is only ever a string.
function quickTopupButtonsRow(amountUsd) {
  const cents = Math.max(1, Math.round(amountUsd * 100));
  // Use the SAME emoji keys as the topup:qris/usdt/ton/binance buttons in the
  // main Wallet menu ('topup_qris'/'topup_usdt'/'topup_ton'/'topup_binance' in
  // emoji-id-menu-inline.js) - so when an admin has already set a premium emoji
  // for those buttons via "🎨 Manage Emoji ID", the same icon is reused here
  // automatically with nothing extra to configure.
  // It returns 2 ROWS (not one row of 4 buttons) so the buttons are not squeezed
  // on today's phone screens now that a fourth method (Binance) exists - callers
  // MUST spread the result (...quickTopupButtonsRow(...)) rather than pushing it
  // as a single array.
  return [
    [
      withButtonIcon({ text: '📱 QRIS', callback_data: `qtopup:qris:${cents}` }, 'topup_qris'),
      withButtonIcon({ text: '💵 USDT', callback_data: `qtopup:usdt:${cents}` }, 'topup_usdt')
    ],
    [
      withButtonIcon({ text: '💎 TON', callback_data: `qtopup:ton:${cents}` }, 'topup_ton'),
      withButtonIcon({ text: 'Binance', callback_data: `qtopup:binance:${cents}` }, 'topup_binance')
    ]
  ];
}

function confirmKeyboard(productId, variantId, qty, chatId, shortfall) {
  const ref = productRef(productId, variantId);
  const rows = [
    [withButtonIcon({ text: lang.t(chatId, 'btn_place_order'), callback_data: `confirm:${ref}:${qty}` }, 'place_order')],
    [withButtonIcon({ text: lang.t(chatId, 'btn_cancel_order'), callback_data: `variant:${ref}` }, 'cancel_order')]
  ];
  // When the user's balance is still short for this order, add the quick-topup
  // row (QRIS/USDT/TON/Binance) right here - the user just presses one without
  // leaving for the Wallet menu, and the amount is automatically the SHORTFALL
  // (not the order total), so once they have paid the balance is exactly enough.
  // pas cukup.
  if (shortfall > 0) {
    rows.push(...quickTopupButtonsRow(shortfall));
  }
  return { inline_keyboard: rows };
}

async function showOrderConfirmation(chatId, messageId, productId, variantId, qty) {
  const product = db.findProduct(productId);
  const variant = db.findVariant(productId, variantId);
  if (!product || !variant || !qty || qty <= 0) {
    return bot.sendMessage(chatId, lang.t(chatId, 'invalid_qty'));
  }
  const unitPrice = db.getUnitPriceForQty(variant, qty);
  const total = Math.round(unitPrice * qty * 100) / 100; // see the floating-point bug fix note in the 'confirm:' handler
  const user = db.getUser(chatId);
  const shortfall = Math.max(0, total - user.balance);

  const text =
    `${lang.t(chatId, 'order_confirm_title', { title_icon: teksEmoji('order_confirm_title', '✅') })}\n\n` +
    lang.t(chatId, 'order_confirm_body', {
      product: `${productEmojiHtml(product)} ${escapeHtml(product.name)} - ${escapeHtml(variant.label)}`,
      qty,
      total: usd(total, chatId),
      balance: usd(user.balance, chatId),
      stock: stockLabel(variant),
      balance_icon: teksEmoji('order_confirm_balance', '💰'),
      stock_icon: teksEmoji('order_confirm_stock', '⭐')
    });

  const opts = { parse_mode: 'HTML', reply_markup: confirmKeyboard(productId, variantId, qty, chatId, shortfall) };
  if (messageId) {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts }).catch(() => {
      bot.sendMessage(chatId, text, opts);
    });
  } else {
    bot.sendMessage(chatId, text, opts);
  }
}

// ================= START =================

bot.onText(/^\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const isNewUser = !db.readDb().users[chatId];
  db.getUser(chatId, msg.from.username);

  // The Maintenance Mode gate: admins always keep normal access (so the owner is
  // never locked out of their own bot), but EVERY other user is shown the
  // maintenance message and stops here - never reaching the referral step, the
  // force-join gate, or the main menu at all.
  // utama sama sekali.
  if (!isAdmin(chatId) && db.getMaintenanceSettings().enabled) {
    return bot.sendMessage(chatId, buildMaintenanceText(chatId), { parse_mode: 'HTML' });
  }

  // The payload from the deep link https://t.me/<bot>?start=<referrerChatId> is
  // only processed when this user is GENUINELY new (has never pressed /start
  // before), so an existing user cannot "refer" themselves over and over just by
  // reopening the same link.
  // ===== PATCH v7: the reward is NO LONGER granted here (see db.registerReferral()
  // and db.creditReferralOnFirstDeposit() for the full explanation of why) - this
  // only records the relationship. The reward is credited later, once this user
  // really tops up their balance for the first time through a real payment gateway.
  const referrerChatId = match && match[1] ? match[1].trim() : null;
  if (isNewUser && referrerChatId) {
    db.registerReferral(chatId, referrerChatId);
  }

  // Admins always get straight in without the force-join requirement, so the
  // owner is never locked out of their own bot (by forgetting to join their own
  // channel, for example).
  if (!isAdmin(chatId)) {
    const passed = await checkForceJoinAndPrompt(chatId, null);
    if (!passed) return;
  }

  bot.sendMessage(
    chatId,
    buildWelcomeText(chatId),
    { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(chatId) }
  );
});

// ================= CALLBACK QUERY =================

// A safe wrapper around editMessageText - when the content is EXACTLY the same as
// what is already on screen (Telegram rejects that with a "message is not
// modified" error, which happens most often when a user DOUBLE-TAPS the same
// button, or a slow connection makes Telegram deliver the same callback twice),
// stay quiet WITHOUT sending a new message (so the chat is not cluttered with
// duplicates). For any other error (the message being too old to edit, say), fall
// back to sending a new message as usual.
async function safeEditMessage(chatId, messageId, text, opts) {
  try {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts });
  } catch (err) {
    const desc = (err && err.response && err.response.body && err.response.body.description) || (err && err.message) || '';
    if (/message is not modified/i.test(desc)) {
      return; // what we wanted to show is already there - safe to ignore
    }
    await bot.sendMessage(chatId, text, opts).catch(() => {});
  }
}

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  // Callback data starting with "admin:" is handled ENTIRELY by the SECOND
  // bot.on('callback_query', ...) handler below (see its
  // `if (!data.startsWith('admin:') ...) return;` guard). Without this guard, THIS
  // first handler would still run down to the `bot.answerCallbackQuery` line at
  // the very bottom (since no if/else matches 'admin:...' data) and ANSWER that
  // callback query first with an EMPTY toast - Telegram only allows one answer per
  // callback query, so the real toast/alert from the admin handler ("⚠️ Product
  // not found.", say) would silently FAIL TO APPEAR. This guard prevents that bug.
  // secara diam-diam. Guard ini mencegah bug itu.
  if (data.startsWith('admin:')) return;

  // ===== Guard for the live-repaint feature (see openProductListMsg and
  // scheduleProductListRepaint() above) =====
  // This bot (like most Telegram bots) EDITS the SAME message in place whenever a
  // user moves between menus (rather than sending a new one each time) - so a
  // single message_id can show the main menu, the product list, the balance, and
  // so on in turn, depending on the last button pressed.
  // openProductListMsg tracks the LAST message_id that displayed the
  // product list, so its colours can be repainted later - BUT if the user then
  // navigates to a DIFFERENT menu on that SAME message_id (opening a product's
  // 'desc:', or going back to 'menu:main'), that message is NO LONGER showing the
  // product list. Without this guard, the next repaint job would overwrite that
  // NEW menu's keyboard with productListKeyboard() - completely wrong, and it
  // could make another menu's buttons look like the product list while the text
  // says something else.
  // This guard clears the tracking BEFORE any branch runs whenever the data is NOT
  // 'menu:products' - the 'menu:products' handler itself immediately re-registers
  // the tracking straight afterwards (see below), so that case stays safe.
  if (data !== 'menu:products') openProductListMsg.delete(chatId);
  // The same guard for detail page tracking (openProductDescMsg) - the 'desc:'
  // handler below re-registers it when the data really is 'desc:...', so it is
  // safe to clear here for every other case.
  if (!data.startsWith('desc:')) openProductDescMsg.delete(chatId);

  try {
    // ---- Force Join Channel/Group: the "✅ I've Joined" check (auto-detected) ----
    if (data === 'checkjoin') {
      const unjoined = await getUnjoinedChannels(chatId);
      if (unjoined.length) {
        const { channels } = db.getForceJoinSettings();
        await safeEditMessage(chatId, messageId, forceJoinText(chatId, unjoined, channels), {
          parse_mode: 'HTML', reply_markup: forceJoinKeyboard(chatId, channels)
        });
        return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'forcejoin_still_locked'), show_alert: true }).catch(() => {});
      }
      bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'forcejoin_all_joined_toast') }).catch(() => {});
      const welcomeText = buildWelcomeText(chatId);
      return safeEditMessage(chatId, messageId, welcomeText, { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(chatId) });
    }

    // ---- Maintenance Mode gate: block EVERY other menu interaction while the
    // feature is on (admins always pass, like the force-join gate). ----
    if (!isAdmin(chatId) && db.getMaintenanceSettings().enabled) {
      await safeEditMessage(chatId, messageId, buildMaintenanceText(chatId), { parse_mode: 'HTML' });
      return bot.answerCallbackQuery(query.id).catch(() => {});
    }

    // ---- Force-join gate: block EVERY other menu interaction while the feature
    // is on and the user still has an unjoined channel (admins always pass). ----
    if (!isAdmin(chatId)) {
      const passed = await checkForceJoinAndPrompt(chatId, messageId);
      if (!passed) return bot.answerCallbackQuery(query.id).catch(() => {});
    }

    // ---- Main menu navigation ----
    if (data === 'menu:main') {
      db.clearPendingAction(chatId);
      const welcomeText = buildWelcomeText(chatId);
      await safeEditMessage(chatId, messageId, welcomeText, { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(chatId) });
    }

    else if (data === 'menu:products') {
      db.clearPendingAction(chatId);
      await bot.editMessageText(lang.t(chatId, 'products_title'), {
        chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: await productListKeyboard(chatId)
      });
      // Register this message so scheduleProductListRepaint() can refresh its
      // button colours later if stock changes WHILE the buyer still has this menu
      // on screen (see the openProductListMsg definition above).
      // openProductListMsg di atas).
      openProductListMsg.set(chatId, messageId);
    }

    else if (data === 'menu:balance') {
      db.clearPendingAction(chatId);
      const user = db.getUser(chatId, query.from.username);
      await bot.editMessageText(lang.t(chatId, 'balance_line', { balance: usd(user.balance, chatId), icon: teksEmoji('balance_line', '💰') }), {
        chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[withButtonIcon({ text: lang.t(chatId, 'btn_back'), callback_data: 'menu:main' }, 'back')]] }
      });
    }

    // ---- Gift (Buy Gift / Confess Gift, via the GramJS userbot - see userbot.js) ----
    // The main menu has only one combined "🎁 Buy Gift / Confess Gift" button ->
    // this submenu then asks whether they want "buy" mode (no message, on behalf
    // of the store) or "confess" (plus an anonymous message, identity hidden).
    else if (data === 'gift:mode') {
      db.clearPendingAction(chatId);
      if (!userbot.isConfigured()) {
        await bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'gift_not_configured'), show_alert: true });
        return;
      }
      await safeEditMessage(chatId, messageId,
        lang.t(chatId, 'gift_mode_title'),
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [withStyle({ text: lang.t(chatId, 'btn_gift_buy'), callback_data: 'gift:list:buy' }, 'success')],
              [withStyle({ text: lang.t(chatId, 'btn_gift_confess'), callback_data: 'gift:list:confess' }, 'success')],
              [withButtonIcon({ text: lang.t(chatId, 'btn_back'), callback_data: 'menu:main' }, 'back')]
            ]
          }
        }
      );
    }

    else if (data.startsWith('gift:list:')) {
      db.clearPendingAction(chatId);
      const mode = data.split(':')[2]; // 'buy' | 'confess'
      if (!userbot.isConfigured()) {
        await bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'gift_not_configured'), show_alert: true });
        return;
      }
      await bot.editMessageText(giftListText(chatId, mode), {
        chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: await giftListKeyboard(chatId, mode)
      });
    }

    else if (data.startsWith('gift:pick:')) {
      const [, , mode, giftId] = data.split(':');
      let gift = null;
      try {
        const catalog = await userbot.getGiftCatalog();
        gift = catalog.find(g => g.id === giftId);
      } catch (err) {
        logError('gift:pick catalog', err);
      }
      if (!gift) {
        await bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'gift_not_found'), show_alert: true });
        return;
      }
      db.setPendingAction(chatId, { type: 'gift_target', data: { mode, giftId, stars: gift.stars } });
      await bot.editMessageText(await giftDetailText(chatId, gift, mode), {
        chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: giftCancelKeyboard(chatId)
      });
    }

    else if (data.startsWith('gift:confirm:')) {
      // Stop a double-tap or duplicate callback triggering 2 gift orders running
      // at once for the same chatId - using the same lock as the 'confirm:'
      // handler (ordinary product orders) above. Without it, a double tap on
      // "✅ Send Now" could pass the balance check twice before either had
      // cleared the pending action or updated the balance (because there is an
      // `await userbot.getUserbotStarsBalance()` in between), so the user would be
      // charged twice and the gift sent twice for one confirmation.
      if (pendingOrderConfirms.has(chatId)) {
        return bot.answerCallbackQuery(query.id, { text: '⏳ Your previous order is still processing, please wait a moment...', show_alert: true }).catch(() => {});
      }
      pendingOrderConfirms.add(chatId);
      try {
      const confirmToken = data.split(':')[2];
      const pending = db.getPendingAction(chatId);
      if (!pending || pending.type !== 'gift_confirm' || pending.data.confirmToken !== confirmToken) {
        await bot.answerCallbackQuery(query.id, { text: '⚠️ This order session has expired, please start again from the Gift menu.', show_alert: true });
        return;
      }
      const { priceUsd, stars } = pending.data;
      const user = db.getUser(chatId, query.from.username);
      if (user.balance < priceUsd) {
        // Just like an ordinary product order (see the 'confirm:' handler above) -
        // not merely a toast alert, but an actionable message with quick-topup
        // buttons (QRIS/USDT/TON/Binance) for EXACTLY the shortfall, so the user
        // can pay straight away without leaving for the Wallet menu and then
        // hunting for the gift again. The gift_confirm pending action is
        // DELIBERATELY kept, so that once the balance is enough the user only has
        // to tap "✅ Send Now" again on the earlier confirmation message rather
        // than starting over.
        const shortfall = priceUsd - user.balance;
        await bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'insufficient_balance'), show_alert: true }).catch(() => {});
        await bot.sendMessage(chatId,
          `${teksEmoji('insufficient_balance_warn', '⚠️')} ${lang.t(chatId, 'insufficient_balance')}\n\n${teksEmoji('insufficient_balance_shortfall', '💰')} ${lang.t(chatId, 'insufficient_balance_shortfall_label')}: <b>${usd(shortfall, chatId)}</b>\n\n${lang.t(chatId, 'insufficient_balance_cta')}`,
          { parse_mode: 'HTML', reply_markup: { inline_keyboard: quickTopupButtonsRow(shortfall) } }
        );
        return;
      }

      // Check the userbot account's Stars balance BEFORE deducting the buyer's
      // balance - when Stars have run out, the buyer must NOT be charged at all;
      // they are simply asked to wait for an admin top-up and order again. The
      // pending action is deliberately NOT cleared here so the buyer can tap
      // "✅ Send Now" again as soon as the Stars are topped up, without starting
      // over (picking the gift and typing the target again).
      try {
        const starsBalance = await userbot.getUserbotStarsBalance();
        if (starsBalance < stars) {
          await bot.answerCallbackQuery(query.id, {
            text: `⚠️ The store's Stars are out of stock. Your balance has NOT been charged.`,
            show_alert: true
          });
          await bot.sendMessage(chatId,
            `⚠️ <b>The store's Stars are out of stock</b>, the admin has not topped up yet.\n\n` +
            `💰 Your wallet balance was <b>not charged at all</b> - you are safe.\n` +
            `🔁 Your order is still saved; just tap <b>"✅ Send Now"</b> again on the earlier confirmation message whenever you want to retry.`,
            { parse_mode: 'HTML' }
          );
          return;
        }
      } catch (err) {
        // If the balance check itself fails (the userbot being disconnected, say),
        // do not block the buyer here - let it continue; a genuine failure will
        // still be caught and refunded automatically in executeGiftSend() below.
        logError('gift:confirm pre-check stars balance', err);
      }

      db.clearPendingAction(chatId);
      db.updateBalance(chatId, -priceUsd);
      const order = db.createGiftOrder({
        chatId, username: query.from.username, mode: pending.data.mode,
        giftId: pending.data.giftId, stars: pending.data.stars, priceUsd,
        target: pending.data.target, message: pending.data.message
      });
      await bot.editMessageText(`⏳ Sending the gift to <b>${escapeHtml(pending.data.target)}</b>...`, {
        chat_id: chatId, message_id: messageId, parse_mode: 'HTML'
      });
      executeGiftSend(chatId, order); // async, deliberately not awaited - the result arrives as a new message
      } finally {
        pendingOrderConfirms.delete(chatId);
      }
    }

    else if (data === 'menu:topup') {
      db.clearPendingAction(chatId);
      await bot.editMessageText(
        lang.t(chatId, 'topup_title', { emoji_wallet: teksEmoji('wallet_title', '💳') }),
        { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: topupMethodKeyboard(chatId) }
      );
    }

    else if (data === 'topup:qris') {
      if (!PAYKITA_API_KEY) {
        await bot.editMessageText(lang.t(chatId, 'topup_qris_not_configured'), {
          chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: cancelToTopupKeyboard(chatId)
        });
      } else {
        db.clearPendingAction(chatId);
        await bot.editMessageText(
          lang.t(chatId, 'qris_choose_amount_title', { emoji_qris_amount: teksEmoji('qris_choose_amount_title', '💰') }),
          { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: qrisAmountKeyboard(chatId) }
        );
      }
    }

    else if (data.startsWith('qrisamt:')) {
      const amount = Number(data.slice('qrisamt:'.length));
      if (!amount || amount < MIN_TOPUP_AMOUNT || amount > MAX_TOPUP_AMOUNT) {
        return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'qris_invalid_amount') });
      }
      await bot.editMessageText(lang.t(chatId, 'qris_creating', { amount: usd(amount, chatId), emoji_hourglass: teksEmoji('qris_creating', '⏳') }), {
        chat_id: chatId, message_id: messageId, parse_mode: 'HTML'
      }).catch(() => {});
      await startQrisTopup(chatId, amount);
    }

    else if (data === 'qris:custom') {
      db.setPendingAction(chatId, { type: 'topup_qris_amount' });
      const minUsd = await getMinQrisUsd();
      await bot.editMessageText(
        lang.t(chatId, 'qris_custom_prompt', { min: usd(minUsd, chatId) }),
        { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: cancelToQrisAmountKeyboard(chatId) }
      );
    }

    else if (data.startsWith('qris:cancel:')) {
      const depositId = data.slice('qris:cancel:'.length);
      const deposit = db.getDeposit(depositId);
      // Fix: stop ANOTHER user cancelling someone else's pending deposit
      // (callback_data can be sent by hand from a custom client, so it must not be
      // trusted without verifying ownership).
      if (deposit && deposit.status === 'pending' && deposit.chatId === chatId) {
        db.updateDeposit(depositId, { status: 'cancelled' });
      }
      try {
        await bot.deleteMessage(chatId, messageId);
      } catch (err) {
        // the message may already be deleted or resent - safe to ignore
      }
      await bot.sendMessage(
        chatId,
        buildWelcomeText(chatId),
        { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(chatId) }
      );
      return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'toast_payment_cancelled') }).catch(() => {});
    }

    else if (data.startsWith('usdt:cancel:')) {
      const depositId = data.slice('usdt:cancel:'.length);
      const deposit = db.getDeposit(depositId);
      // Fix: stop ANOTHER user cancelling someone else's pending deposit.
      if (deposit && deposit.status === 'pending' && deposit.chatId === chatId) {
        db.updateDeposit(depositId, { status: 'cancelled' });
      }
      try {
        await bot.deleteMessage(chatId, messageId);
      } catch (err) {
        // the message may already be deleted or resent - safe to ignore
      }
      await bot.sendMessage(
        chatId,
        buildWelcomeText(chatId),
        { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(chatId) }
      );
      return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'toast_topup_cancelled') }).catch(() => {});
    }

    else if (data === 'topup:usdt') {
      if (!USDT_BEP20_ADDRESS) {
        await bot.editMessageText(lang.t(chatId, 'topup_usdt_not_configured'), {
          chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: cancelToTopupKeyboard(chatId)
        });
      } else {
        db.setPendingAction(chatId, { type: 'topup_usdt_amount' });
        await bot.editMessageText(
          lang.t(chatId, 'usdt_topup_prompt', { min: usd(MIN_TOPUP_USDT_AMOUNT, chatId), max: usd(MAX_TOPUP_AMOUNT, chatId), emoji_usdt: teksEmoji('usdt_prompt', '💵') }),
          { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: cancelToTopupKeyboard(chatId) }
        );
      }
    }

    else if (data.startsWith('ton:cancel:')) {
      const depositId = data.slice('ton:cancel:'.length);
      const deposit = db.getDeposit(depositId);
      // Fix: stop ANOTHER user cancelling someone else's pending deposit.
      if (deposit && deposit.status === 'pending' && deposit.chatId === chatId) {
        db.updateDeposit(depositId, { status: 'cancelled' });
      }
      try {
        await bot.deleteMessage(chatId, messageId);
      } catch (err) {
        // the message may already be deleted or resent - safe to ignore
      }
      await bot.sendMessage(
        chatId,
        buildWelcomeText(chatId),
        { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(chatId) }
      );
      return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'toast_topup_cancelled') }).catch(() => {});
    }

    else if (data === 'topup:ton') {
      if (!TON_ADDRESS) {
        await bot.editMessageText(lang.t(chatId, 'topup_ton_not_configured'), {
          chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: cancelToTopupKeyboard(chatId)
        });
      } else {
        db.setPendingAction(chatId, { type: 'topup_ton_amount' });
        await bot.editMessageText(
          lang.t(chatId, 'ton_topup_prompt', { min: usd(MIN_TOPUP_TON_AMOUNT, chatId), max: usd(MAX_TOPUP_AMOUNT, chatId), emoji_ton: teksEmoji('ton_prompt', '💎') }),
          { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: cancelToTopupKeyboard(chatId) }
        );
      }
    }

    else if (data.startsWith('binance:cancel:')) {
      const depositId = data.slice('binance:cancel:'.length);
      const deposit = db.getDeposit(depositId);
      // Fix: stop ANOTHER user cancelling someone else's pending deposit.
      if (deposit && deposit.status === 'pending' && deposit.chatId === chatId) {
        db.updateDeposit(depositId, { status: 'cancelled' });
      }
      try {
        await bot.deleteMessage(chatId, messageId);
      } catch (err) {
        // the message may already be deleted or resent - safe to ignore
      }
      await bot.sendMessage(
        chatId,
        buildWelcomeText(chatId),
        { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(chatId) }
      );
      return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'toast_topup_cancelled') }).catch(() => {});
    }

    else if (data === 'topup:binance') {
      if (!BINANCE_API_KEY || !BINANCE_PAY_ID) {
        await bot.editMessageText(lang.t(chatId, 'topup_binance_not_configured'), {
          chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: cancelToTopupKeyboard(chatId)
        });
      } else {
        db.setPendingAction(chatId, { type: 'topup_binance_amount' });
        await bot.editMessageText(
          lang.t(chatId, 'binance_topup_prompt', { min: usd(MIN_TOPUP_BINANCE_AMOUNT, chatId), max: usd(MAX_TOPUP_AMOUNT, chatId), emoji_binance: teksEmoji('binance_prompt', '🟡') }),
          { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: cancelToTopupKeyboard(chatId) }
        );
      }
    }

    // ---- Quick topup (the QRIS/USDT/TON buttons on the Order Confirmation
    // page, or in the "balance short" message) - unlike the ordinary
    // topup:qris/usdt/ton, this SKIPS the choose-amount screen: the amount is
    // decided up front (sent in callback_data, in CENTS) to match the shortfall on
    // the order being processed, so the user need not work it out or type it again.
    else if (data.startsWith('qtopup:')) {
      const [, method, centsStr] = data.split(':');
      const amountUsd = Number(centsStr) / 100;
      if (!amountUsd || isNaN(amountUsd) || amountUsd <= 0) {
        return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'qris_invalid_amount') });
      }

      if (method === 'qris') {
        if (!PAYKITA_API_KEY) {
          return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'topup_qris_not_configured').replace(/[`*_]/g, ''), show_alert: true });
        }
        const minUsd = await getMinQrisUsd();
        const finalAmount = Math.max(amountUsd, minUsd);
        await bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'toast_creating_qris') }).catch(() => {});
        await startQrisTopup(chatId, finalAmount);
      } else if (method === 'usdt') {
        if (!USDT_BEP20_ADDRESS) {
          return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'topup_usdt_not_configured').replace(/[`*_]/g, ''), show_alert: true });
        }
        const finalAmount = Math.max(amountUsd, MIN_TOPUP_USDT_AMOUNT);
        await bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'toast_creating_usdt_invoice') }).catch(() => {});
        await startUsdtTopup(chatId, finalAmount);
      } else if (method === 'ton') {
        if (!TON_ADDRESS) {
          return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'topup_ton_not_configured').replace(/[`*_]/g, ''), show_alert: true });
        }
        const finalAmount = Math.max(amountUsd, MIN_TOPUP_TON_AMOUNT);
        await bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'toast_creating_ton_invoice') }).catch(() => {});
        await startTonTopup(chatId, finalAmount);
      } else if (method === 'binance') {
        if (!BINANCE_API_KEY || !BINANCE_PAY_ID) {
          return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'topup_binance_not_configured').replace(/[`*_]/g, ''), show_alert: true });
        }
        const finalAmount = Math.max(amountUsd, MIN_TOPUP_BINANCE_AMOUNT);
        await bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'toast_creating_binance_invoice') }).catch(() => {});
        await startBinanceTopup(chatId, finalAmount);
      } else {
        return bot.answerCallbackQuery(query.id).catch(() => {});
      }
      return;
    }

    else if (data === 'menu:history') {
      db.clearPendingAction(chatId);
      const orders = db.getOrdersByUser(chatId);
      if (orders.length === 0) {
        await bot.editMessageText(lang.t(chatId, 'orders_empty', { emoji_orders: teksEmoji('orders_empty', '🧾') }), {
          chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[withButtonIcon({ text: lang.t(chatId, 'btn_back'), callback_data: 'menu:main' }, 'back')]] }
        });
      } else {
        const blocks = orders.slice(0, 5).map(o => {
          const p = db.findProduct(o.productId);
          const v = p ? p.variants.find(x => x.id === o.variantId) : null;
          const name = p ? `${productEmojiHtml(p)} ${escapeHtml(p.name)}${v && v.label ? ' ' + escapeHtml(v.label) : ''}` : escapeHtml(o.productId);
          const statusLabel = o.status === 'paid' ? 'success' : escapeHtml(o.status);
          return (
            `<b>${lang.t(chatId, 'order_id_label')}:</b> <code>${escapeHtml(o.id)}</code>\n` +
            `<b>${lang.t(chatId, 'order_product_label')}:</b> ${name} (x${o.qty})\n` +
            `<b>${lang.t(chatId, 'order_status_label')}:</b> ${statusLabel}`
          );
        }).join('\n\n');
        await bot.editMessageText(`${lang.t(chatId, 'orders_title')}\n\n${blocks}`, {
          chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_recover'), callback_data: 'orders:recover' }, 'recover'), 'primary')],
              [withStyle(withButtonIcon({ text: lang.t(chatId, 'btn_cancel'), callback_data: 'menu:main' }, 'cancel_recover'), 'danger')]
            ]
          }
        });
      }
    }

    else if (data === 'orders:recover') {
      db.setPendingAction(chatId, { type: 'recover_order_id' });
      await bot.editMessageText(
        lang.t(chatId, 'recover_title'),
        {
          chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[withButtonIcon({ text: lang.t(chatId, 'btn_back'), callback_data: 'menu:history' }, 'back')]] }
        }
      );
    }

    else if (data === 'menu:profile') {
      db.clearPendingAction(chatId);
      await bot.editMessageText(profileText(chatId, query.from), {
        chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: profileKeyboard(chatId)
      });
    }

    else if (data === 'menu:howtouse') {
      db.clearPendingAction(chatId);
      await bot.editMessageText(
        lang.t(chatId, 'howto_title', { emoji_howto: teksEmoji('howto_title', '❗️') }),
        { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: howToListKeyboard(chatId) }
      );
    }

    else if (data === 'howtouse:close') {
      try {
        await bot.deleteMessage(chatId, messageId);
      } catch (err) {
        // the message may already be deleted - safe to ignore
      }
      return bot.answerCallbackQuery(query.id).catch(() => {});
    }

    else if (data === 'menu:support') {
      db.clearPendingAction(chatId);
      const ownerId = ADMIN_IDS && ADMIN_IDS[0];
      const supportVars = { emoji_support: teksEmoji('support_title', '📞') };
      const text = ownerId ? lang.t(chatId, 'support_title', supportVars) : lang.t(chatId, 'support_title_noadmin', supportVars);
      await bot.editMessageText(text, {
        chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: supportKeyboard(chatId)
      });
    }

    else if (data === 'menu:referral') {
      db.clearPendingAction(chatId);
      await bot.editMessageText(referralText(chatId), {
        chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: referralKeyboard(chatId)
      });
    }
    else if (data === 'referral:copy') {
      // This branch is NOW only reachable when BOT_USERNAME is unset (see
      // referralKeyboard) - the referral link cannot be built yet.
      return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'referral_username_missing'), show_alert: true });
    }

    // ---- Product description page ----
    else if (data.startsWith('desc:')) {
      db.clearPendingAction(chatId);
      const [, ref] = data.split(':');
      const resolved = resolveProductRef(ref);
      const product = resolved && db.findProduct(resolved.productId);
      const variant = resolved && db.findVariant(resolved.productId, resolved.variantId);
      if (!product || !variant) return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'product_not_found') });
      const { productId, variantId } = resolved;

      // Live-check Canboso stock here (the same pattern as productListKeyboard()
      // and the 'variant:' handler) so the "Buy Now" button colour on this page is
      // fresh too, rather than relying on a stale cache - getLiveStock() is itself
      // cached for 20 seconds in supplierCanboso.js, so it is safe to call here.
      if (variant.canbosoProductId) {
        try {
          const live = await canboso.getLiveStock(variant.canbosoProductId);
          if (live && !isNaN(live.stock)) {
            db.setVariantStock(productId, variantId, live.stock);
            variant.liveStock = live.stock;
          }
        } catch (err) {
          console.error(`Canboso getLiveStock (desc) failed (product_id=${variant.canbosoProductId}):`, err.message);
        }
      }

      const header = `${productEmojiHtml(product)} <b>${escapeHtml(product.name)} - ${escapeHtml(variant.label)}</b>\n\n`;
      const descText = variant.description || '';
      const body = descText
        ? `<blockquote>${renderDescription(descText)}</blockquote>`
        : `<blockquote>${lang.t(chatId, 'desc_fallback', { price: usd(db.getBasePrice(variant), chatId), stock: stockLabel(variant) })}</blockquote>`;

      await bot.editMessageText(header + body, {
        chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
        reply_markup: descKeyboard(productId, variantId, chatId, product, variant)
      });
      // Register this page so scheduleProductListRepaint() also refreshes its
      // "Buy Now" button colour while the buyer still has this detail page open
      // (see openProductDescMsg above).
      openProductDescMsg.set(chatId, { messageId, productId, variantId });
    }

    // ---- The How to Use page, opened from the "ORDER SUCCESSFUL" message (which
    // carries only the orderId - see the note in successKeyboard() for why) ----
    else if (data.startsWith('howtoorder:')) {
      db.clearPendingAction(chatId);
      const orderId = data.slice('howtoorder:'.length);
      const order = db.getOrderById(orderId);
      // Like "backtoorder:" - this order MUST belong to the chatId pressing the
      // button, so nobody else can read the how-to-use using an orderId guessed
      // or stolen from another user.
      if (!order || order.chatId !== chatId) return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'order_not_found') });
      const product = db.findProduct(order.productId);
      const variant = db.findVariant(order.productId, order.variantId);
      if (!product || !variant) return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'product_not_found') });

      const text = variant.howToUse
        ? `${lang.t(chatId, 'howto_page_title', { product: `${productEmojiHtml(product)} ${escapeHtml(product.name)} ${escapeHtml(variant.label)}` })}\n\n${renderDescription(variant.howToUse)}`
        : lang.t(chatId, 'howto_not_available');

      await bot.editMessageText(text, {
        chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
        reply_markup: howToKeyboard(order.productId, order.variantId, orderId, chatId)
      });
    }

    // ---- How to use page ----
    else if (data.startsWith('howto:')) {
      db.clearPendingAction(chatId);
      const [, ref, context] = data.split(':');
      const resolved = resolveProductRef(ref);
      const product = resolved && db.findProduct(resolved.productId);
      const variant = resolved && db.findVariant(resolved.productId, resolved.variantId);
      if (!product || !variant) return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'product_not_found') });
      const { productId, variantId } = resolved;

      const text = variant.howToUse
        ? `${lang.t(chatId, 'howto_page_title', { product: `${productEmojiHtml(product)} ${escapeHtml(product.name)} ${escapeHtml(variant.label)}` })}\n\n${renderDescription(variant.howToUse)}`
        : lang.t(chatId, 'howto_not_available');

      await bot.editMessageText(text, {
        chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
        reply_markup: howToKeyboard(productId, variantId, context, chatId)
      });
    }

    // ---- Back from "How to Use" to the original "ORDER SUCCESSFUL" message
    // (rather than the product description page) - rebuilt from the stored order.
    else if (data.startsWith('backtoorder:')) {
      const [, orderId] = data.split(':');
      const order = db.getOrderById(orderId);
      // IMPORTANT - IDOR fix: THIS order MUST belong to the chatId pressing the
      // button, the same check already present in refresh2fa: and
      // refresh2fa:recover: below. Without it, anyone able to send a
      // callback_query with data "backtoorder:<orderId>" for SOMEONE ELSE's order
      // ID (via a custom or modified Telegram client - callback_data is NOT
      // cryptographically bound to its original button, so it cannot be trusted)
      // could re-read another user's auto-delivered account/2FA details through
      // buildSuccessText().
      if (!order || order.chatId !== chatId) return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'order_not_found') });
      const product = db.findProduct(order.productId);
      const variant = db.findVariant(order.productId, order.variantId);
      if (!product || !variant) return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'product_not_found') });

      const successText = buildSuccessText(product, variant, order.qty, order.total, order.id, order.deliveredItems, chatId);
      await bot.editMessageText(successText, {
        chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
        reply_markup: successKeyboard(order.productId, order.variantId, order.id, order.deliveredItems, chatId)
      });
    }

    // ---- Refresh the 2FA code (live TOTP) - used both in the "ORDER SUCCESSFUL"
    // message (refresh2fa:<orderId>) and in the "Recover Product" message
    // (refresh2fa:recover:<orderId>). A TOTP code changes every 30 seconds, so
    // this button simply re-renders the same message - buildSuccessText /
    // formatStockItem compute a fresh TOTP code on every call.
    else if (data.startsWith('refresh2fa:recover:')) {
      const orderId = data.slice('refresh2fa:recover:'.length);
      const order = db.getOrderById(orderId);
      if (!order || order.chatId !== chatId) return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'order_not_found') });
      if (!order.delivered || !order.deliveredItems || !order.deliveredItems.length) {
        return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'recover_item_not_recoverable') });
      }
      const product = db.findProduct(order.productId);
      const variant = product ? product.variants.find(v => v.id === order.variantId) : null;
      const label = product ? `${product.name}${variant && variant.label ? ' - ' + variant.label : ''}` : order.productId;
      const text =
        `🏅 <b>${lang.t(chatId, 'recover_result_title')}</b>\n\n📦 ${escapeHtml(label)} (x${order.qty})\n\n` +
        order.deliveredItems.map((item, i) => formatStockItem(item, i, chatId)).join('\n\n');
      await bot.editMessageText(text, {
        chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
        reply_markup: hasLiveTotpSecret(order.deliveredItems)
          ? { inline_keyboard: [[withButtonIcon({ text: lang.t(chatId, 'btn_refresh_2fa'), callback_data: `refresh2fa:recover:${orderId}` }, 'refresh_2fa')]] }
          : undefined
      }).catch(() => {});
      return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'totp_refreshed') }).catch(() => {});
    }

    else if (data.startsWith('refresh2fa:')) {
      const [, orderId] = data.split(':');
      const order = db.getOrderById(orderId);
      if (!order || order.chatId !== chatId) return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'order_not_found') });
      const product = db.findProduct(order.productId);
      const variant = db.findVariant(order.productId, order.variantId);
      if (!product || !variant) return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'product_not_found') });

      const successText = buildSuccessText(product, variant, order.qty, order.total, order.id, order.deliveredItems, chatId);
      await bot.editMessageText(successText, {
        chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
        reply_markup: successKeyboard(order.productId, order.variantId, order.id, order.deliveredItems, chatId)
      }).catch(() => {});
      return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'totp_refreshed') }).catch(() => {});
    }

    // ---- Variant detail -> choose quantity ----
    else if (data.startsWith('variant:')) {
      const [, ref] = data.split(':');
      const resolved = resolveProductRef(ref);
      const product = resolved && db.findProduct(resolved.productId);
      const variant = resolved && db.findVariant(resolved.productId, resolved.variantId);
      if (!product || !variant) return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'variant_not_found') });
      const { productId, variantId } = resolved;
      // This now applies to Supplier API variants too - their variant.stock is
      // synced automatically from the supplier's live stock (see
      // refreshSupplierData()), so it is safe for this initial check as well.
      // (placeOrder() in the 'confirm:' handler remains the FINAL validation.)
      // ===== LIVE STOCK CHECK specific to Canboso API variants =====
      // Unlike the Supplier API (a scheduled auto-sync), Canboso variants are
      // checked DIRECTLY against the API every time a buyer opens this page
      // (cached for 20 seconds in supplierCanboso.js so the API is not spammed
      // when many buyers open the same product at nearly the same moment) - while
      // also storing the number in the local variant.stock so the stock display
      // (stockLabel below) and the admin menu update too. When the fetch FAILS
      // (network/API down) or the product no longer exists on Canboso
      // (getLiveStock returns null), DO NOT block the buyer here - let
      // canboso.purchase() in the 'confirm:' handler be the FINAL validation, so a
      // brief Canboso API problem does not make the store look "sold out" when the
      // check merely failed.
      // ===== BUG FIX: variant.stock IS SHARED by manual stock
      // (stockItems.length, see db.addStockItems) AND live remote stock
      // (Supplier/Canboso, via db.setVariantStock from the scheduled sync) - two
      // sources overwriting the SAME field. If this variant has EVER been linked
      // to a Supplier/Canboso API but the admin has ALSO entered manual stock, the
      // next live sync could overwrite variant.stock with 0/empty (whenever the
      // external API's balance/stock ran out) even though local manual stock is
      // still there and ready to deliver - wrongly showing the buyer "out of
      // stock" when the order could have been filled from manual stock.
      // Manual stock is therefore checked FIRST here, so it never blocks a buyer
      // while manual stock remains (see the same priority in the 'confirm:'
      // handler - localStockAvailable).
      // ===== PATCH: variant.liveStock (no longer variant.stock) is what stores
      // the live Supplier/Canboso number - see db.setVariantStock() for the
      // history of why they were separated.
      const localCountForGate = db.getStockItemCount(productId, variantId);
      if (variant.canbosoProductId) {
        try {
          const live = await canboso.getLiveStock(variant.canbosoProductId);
          if (live && !isNaN(live.stock)) {
            db.setVariantStock(productId, variantId, live.stock);
            variant.liveStock = live.stock;
            if (live.stock <= 0 && localCountForGate <= 0) {
              return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'out_of_stock'), show_alert: true });
            }
          } else if (live) {
            // The product was found but its stock field could not be parsed (NaN)
            // - different from "not found at all" below. This is the most common
            // cause of stale or wrong local stock, so alert the admin.
            alertCanbosoStockIssue(variant, `product found but its stock field was not recognised (fields available: ${describeRawFields(live.raw)})`);
          } else {
            alertCanbosoStockIssue(variant, 'product_id no longer found in the Canboso product list');
          }
        } catch (err) {
          console.error(`Canboso getLiveStock failed (product_id=${variant.canbosoProductId}):`, err.message);
          alertCanbosoStockIssue(variant, `failed to fetch from the Canboso API: ${err.message}`);
        }
      } else if (db.getTotalStock(variant) <= 0) {
        return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'out_of_stock'), show_alert: true });
      }
      db.clearPendingAction(chatId);
      await bot.editMessageText(
        lang.t(chatId, 'enter_qty_title', {
          product: `${productEmojiHtml(product)} <b>${escapeHtml(product.name)} - ${escapeHtml(variant.label)}</b>`,
          tiers: tiersText(variant, chatId),
          stock: stockLabel(variant),
          emoji_warning: teksEmoji('qty_warning', '⚠️'),
          emoji_stock: teksEmoji('qty_stock', '📦')
        }),
        { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: quantityKeyboard(productId, variantId, chatId) }
      );
    }

    // ---- Quick quantity picked ----
    else if (data.startsWith('qtycustom:')) {
      const [, ref] = data.split(':');
      const resolved = resolveProductRef(ref);
      if (!resolved) return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'variant_not_found') });
      const { productId, variantId } = resolved;
      db.setPendingAction(chatId, { type: 'custom_qty', data: { productId, variantId } });
      await bot.sendMessage(chatId, lang.t(chatId, 'ask_custom_qty'));
      return bot.answerCallbackQuery(query.id).catch(() => {});
    }

    else if (data.startsWith('qty:')) {
      const [, ref, qtyStr] = data.split(':');
      const resolved = resolveProductRef(ref);
      if (!resolved) return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'variant_not_found') });
      await showOrderConfirmation(chatId, messageId, resolved.productId, resolved.variantId, parseInt(qtyStr, 10));
    }

    // ---- Confirm purchase (Place Order) ----
    else if (data.startsWith('confirm:')) {
      // Stop a double-tap or duplicate callback triggering 2 orders running at
      // once for the same chatId - see the note on the pendingOrderConfirms
      // declaration above.
      if (pendingOrderConfirms.has(chatId)) {
        return bot.answerCallbackQuery(query.id, { text: '⏳ Your previous order is still processing, please wait a moment...', show_alert: true }).catch(() => {});
      }
      pendingOrderConfirms.add(chatId);
      try {
      const [, ref, qtyStr] = data.split(':');
      const qty = parseInt(qtyStr, 10);
      // ===== BUG FIX (SECURITY): qty MUST be validated as a positive integer =====
      // callback_data cannot be trusted as sent (the same point as the IDOR notes
      // on "backtoorder:"/"refresh2fa:" above) - a custom Telegram client or
      // userbot can fire a callback_query with ANY data, including
      // "confirm:<ref>:-5". Without this guard a negative qty passes the
      // "qty > variant.stock" check (always false for a negative number), makes
      // `total` negative too, makes the "user.balance < total" check pass even at a
      // $0 balance, and then db.updateBalance(chatId, -total) ACTUALLY ADDS to the
      // user's balance without them paying a cent (a free-balance exploit).
      // qty must not be 0 either (an empty $0 order still recorded as successful).
      if (!Number.isInteger(qty) || qty <= 0) {
        return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'invalid_qty'), show_alert: true });
      }
      const resolved = resolveProductRef(ref);
      const product = resolved && db.findProduct(resolved.productId);
      const variant = resolved && db.findVariant(resolved.productId, resolved.variantId);
      if (!product || !variant) return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'product_variant_not_found') });
      const { productId, variantId } = resolved;

      // Supplier API variants are NOW also checked against the local variant.stock
      // - this used to be skipped entirely on the grounds that "real availability
      // is checked live by placeOrder() below", BUT since Supplier API variant
      // stock is synced automatically (on first link and every
      // SUPPLIER_SYNC_INTERVAL_MINUTES, see refreshSupplierData()), the number is
      // accurate enough for an initial check. The benefit: the buyer gets an
      // "insufficient stock" message IMMEDIATELY, without waiting on an API call
      // to the supplier that only fails seconds later. Note: if auto-sync is off
      // (SUPPLIER_SYNC_INTERVAL_MINUTES=0) and the admin has not clicked a manual
      // refresh for a while, this number can be stale - placeOrder() on the
      // supplier's side remains the FINAL source of truth; this check is only an
      // early filter for a faster UX, not a replacement for that validation.
      // FOR Canboso API variants specifically: re-check LIVE stock here (rather
      // than relying on the snapshot from when the buyer opened the 'variant:'
      // page - another buyer may have consumed the stock in between).
      // It uses the same 20-second cache (see getProductsCached() in
      // supplierCanboso.js), so it adds no API load compared with the 'variant:'
      // check when a buyer confirms within 20 seconds. When the fetch FAILS,
      // `liveStockChecked` stays false - qty is NOT validated against the local
      // variant.stock (which could be stale/0 from an earlier sync), and
      // canboso.purchase() below becomes the sole FINAL validation.
      let liveStockChecked = false;
      if (variant.canbosoProductId) {
        try {
          const live = await canboso.getLiveStock(variant.canbosoProductId);
          if (live && !isNaN(live.stock)) {
            db.setVariantStock(productId, variantId, live.stock);
            variant.liveStock = live.stock;
            liveStockChecked = true;
          }
        } catch (err) {
          console.error(`Canboso getLiveStock (confirm) failed (product_id=${variant.canbosoProductId}):`, err.message);
        }
      }
      // ===== BUG FIX: as in the 'variant:' handler - never block on the live
      // number alone while local manual stock (stockItems) still covers this qty.
      //
      // ===== PATCH: variant.liveStock and variant.stock (manual) are now separate
      // fields, ADDED TOGETHER via db.getTotalStock() - no longer
      // Math.max(variant.stock, localCountForConfirmGate), which only took the
      // larger of the two (when ideally both can contribute to the same qty).
      const totalAvailable = db.getTotalStock(variant);
      const shouldCheckStock = !variant.canbosoProductId || liveStockChecked;
      if (shouldCheckStock && qty > totalAvailable) {
        return bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'not_enough_stock', { stock: totalAvailable }), show_alert: true });
      }

      const unitPrice = db.getUnitPriceForQty(variant, qty);
      // ===== BUG FIX: round the total to 2 decimals =====
      // unitPrice * qty is prone to floating-point drift (0.52 * 11 =
      // 5.720000000000001, say). usd() only rounds for DISPLAY, while
      // db.updateBalance()/createOrder() store the raw number - over time a user's
      // balance drifts from what is displayed, which can get a purchase rejected
      // ("insufficient balance") when the displayed balance looks exactly enough.
      const total = Math.round(unitPrice * qty * 100) / 100;
      const user = db.getUser(chatId, query.from.username);
      if (user.balance < total) {
        // Besides the brief toast alert, also send an actionable message with
        // quick-topup buttons (QRIS/USDT/TON) for EXACTLY the shortfall - so the
        // user can pay straight away without leaving for the Wallet menu and then
        // hunting for the product again.
        const shortfall = total - user.balance;
        bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'insufficient_balance'), show_alert: true }).catch(() => {});
        return bot.sendMessage(chatId,
          `${teksEmoji('insufficient_balance_warn', '⚠️')} ${lang.t(chatId, 'insufficient_balance')}\n\n${teksEmoji('insufficient_balance_shortfall', '💰')} ${lang.t(chatId, 'insufficient_balance_shortfall_label')}: <b>${usd(shortfall, chatId)}</b>\n\n${lang.t(chatId, 'insufficient_balance_cta')}`,
          { parse_mode: 'HTML', reply_markup: { inline_keyboard: quickTopupButtonsRow(shortfall) } }
        );
      }

      let deliveredItems = null;
      let supplierMeta = null;
      let deliverySource = 'manual'; // 'manual' | 'local_auto' | 'supplier_api'
      // Keep the RAW response from Canboso (when that route was used) - used
      // SPECIFICALLY to attach to the admin notification if the item/orderId
      // extraction in purchase() turns out to have missed (see adminNote below).
      // Without it the admin is only told "FAILED to extract" with no clue WHICH
      // fields Canboso actually used, so there is nothing to inspect in order to
      // fix the field mapping in supplierCanboso.js - leaving them guessing on
      // every new case.
      let canbosoRawResult = null;

      // ===== BUG FIX: prioritise local manual stock (entered by the admin via
      // "➕ Add Stock") OVER the Supplier API / Canboso API whenever it already
      // covers this qty. Before this fix, a variant that had EVER been linked to a
      // Supplier API (`variant.supplierServiceId` / `variant.canbosoProductId`
      // still set) ALWAYS tried the external API first - even when the admin had
      // added manual links/codes to the local stockItems - and if that external
      // API failed (the store's wallet balance on the supplier's side running out,
      // say), the order was cancelled automatically even though manual stock was
      // ready to deliver. Now: when local stock is enough, it is used
      // (deliverySource = 'local_auto') and the external API is not called AT ALL
      // for this order.
      const localStockAvailable = db.getStockItemCount(productId, variantId);
      const useLocalStock = localStockAvailable >= qty;

      if (useLocalStock) {
        db.updateBalance(chatId, -total);
        try {
          deliveredItems = db.popStockItems(productId, variantId, qty);
        } catch (e) {
          logError('popStockItems', e);
          deliveredItems = null;
        }
        if (deliveredItems) {
          deliverySource = 'local_auto';
        } else {
          db.decrementStock(productId, variantId, qty);
        }
      } else if (variant.supplierServiceId || variant.canbosoProductId) {
        // ===== PATCH: partial fulfilment combining local + Supplier/Canboso.
        // Previously, as soon as local stock < qty the system went fully to the
        // external API for the WHOLE qty (all or nothing) - even though part of
        // the qty could have been filled from local stockItems. Now: take
        // everything available locally first (localStockAvailable, even when short
        // of qty), and only order the remainder (remainderQty) automatically from
        // the external API to make up the difference - no longer the full qty.
        let localPortion = [];
        if (localStockAvailable > 0) {
          try {
            localPortion = db.popStockItems(productId, variantId, localStockAvailable) || [];
          } catch (e) {
            logError('popStockItems_partial', e);
            localPortion = [];
          }
        }
        const remainderQty = qty - localPortion.length;
        const hasLocalPortion = localPortion.length > 0;

        if (variant.supplierServiceId) {
          // Call the Supplier API FIRST, BEFORE the local balance is deducted - if
          // the API order fails (network/timeout, the store's supplier balance
          // running out, or the remote stock being empty), the user's balance MUST
          // stay intact and NO "ghost" order may be recorded without a product
          // actually being delivered. If a localPortion was taken, RETURN it to
          // stockItems (db.restoreStockItems) before returning - so those local
          // items are not lost for nothing when the order is cancelled.
          try {
            const result = await supplier.placeOrder(variant.supplierServiceId, remainderQty);
            const supplierItems = Array.isArray(result.products) ? result.products : [];
            deliveredItems = [...localPortion, ...supplierItems];
            supplierMeta = { supplierServiceId: variant.supplierServiceId, supplierOrderId: result.order_id || null };
            deliverySource = hasLocalPortion ? 'mixed_supplier' : 'supplier_api';
          } catch (err) {
            if (hasLocalPortion) db.restoreStockItems(productId, variantId, localPortion);
            console.error(`Supplier API order failed (service_id=${variant.supplierServiceId}, qty=${remainderQty}):`, err.message);
            const buyerMsgKey = isSupplierBalanceError(err.message) ? 'supplier_balance_empty' : 'supplier_order_failed';
            bot.answerCallbackQuery(query.id, { text: lang.t(chatId, buyerMsgKey), show_alert: true }).catch(() => {});
            notifyAdmins(
              `⚠️ <b>Order via the Supplier API failed</b>\n\n` +
              `User: ${query.from.username ? '@' + escapeHtml(query.from.username) : `ID ${chatId}`} (${chatId})\n` +
              `Product: ${escapeHtml(product.name)} - ${escapeHtml(variant.label)}\n` +
              `Quantity: ${qty}${hasLocalPortion ? ` (${localPortion.length} from local stock, remaining ${remainderQty} attempted via the supplier)` : ''}\n` +
              `Service ID: <code>${escapeHtml(variant.supplierServiceId)}</code>\n` +
              `Error: ${escapeHtml(err.message)}\n\n` +
              `ℹ️ The user's balance has NOT been charged (the order was cancelled automatically, and any local stock used has been restored).`
            );
            return;
          }
          db.updateBalance(chatId, -total);
        } else {
          // canbosoProductId - just like the Supplier API (AIVerse Hub) block
          // above: call the Canboso API FIRST, BEFORE the user's local balance is
          // deducted, and restore localPortion on failure.
          try {
            const result = await canboso.purchase(variant.canbosoProductId, remainderQty);
            const supplierItems = result.items.length ? result.items : [];
            deliveredItems = [...localPortion, ...supplierItems];
            supplierMeta = { supplierServiceId: `canboso:${variant.canbosoProductId}`, supplierOrderId: result.orderId };
            canbosoRawResult = result.raw;
            // Store a slice of the raw response in supplierMeta (persisted in
            // data/db.json via db.createOrder below) SPECIFICALLY when item
            // extraction failed - so the raw response is not lost if the Telegram
            // notification to the admin happens to fail or be missed; it can still
            // be inspected later via "🔍 Check Order ID".
            if (supplierItems.length === 0) {
              supplierMeta.rawDebug = JSON.stringify(result.raw).slice(0, 1000);
            }
            deliverySource = hasLocalPortion ? 'mixed_canboso' : 'canboso_api';
          } catch (err) {
            if (hasLocalPortion) db.restoreStockItems(productId, variantId, localPortion);
            console.error(`Canboso API order failed (product_id=${variant.canbosoProductId}, qty=${remainderQty}):`, err.message);
            const buyerMsgKey = isSupplierBalanceError(err.message) ? 'supplier_balance_empty' : 'supplier_order_failed';
            bot.answerCallbackQuery(query.id, { text: lang.t(chatId, buyerMsgKey), show_alert: true }).catch(() => {});
            notifyAdmins(
              `⚠️ <b>Order via the Canboso API failed</b>\n\n` +
              `User: ${query.from.username ? '@' + escapeHtml(query.from.username) : `ID ${chatId}`} (${chatId})\n` +
              `Product: ${escapeHtml(product.name)} - ${escapeHtml(variant.label)}\n` +
              `Quantity: ${qty}${hasLocalPortion ? ` (${localPortion.length} from local stock, remaining ${remainderQty} attempted via Canboso)` : ''}\n` +
              `Product ID: <code>${escapeHtml(String(variant.canbosoProductId))}</code>\n` +
              `Error: ${escapeHtml(err.message)}\n\n` +
              `ℹ️ The user's balance has NOT been charged (the order was cancelled automatically, and any local stock used has been restored).`
            );
            return;
          }
          db.updateBalance(chatId, -total);
        }
      } else {
        // There is not enough local manual stock, and this variant is not linked
        // to a Supplier API / Canboso API either - fall back to the old manual
        // flow (the admin sends the account/details to the buyer themselves).
        db.updateBalance(chatId, -total);
        db.decrementStock(productId, variantId, qty);
      }

      const orderId = db.createOrder(chatId, productId, variantId, qty, unitPrice, total, deliveredItems, query.from.username, supplierMeta);
      const successText = buildSuccessText(product, variant, qty, total, orderId, deliveredItems, chatId);

      // Automatic channel notification: "🎉 New Purchase!" (when the feature is on
      // - see sendChannelNotif()). Called here rather than after editMessageText
      // below, so it still reaches the channel even if the send to the buyer fails.
      sendChannelNotif('purchase', buildChannelPurchaseText(chatId, product, variant, qty, total), product);

      await bot.editMessageText(successText, {
        chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
        reply_markup: successKeyboard(productId, variantId, orderId, deliveredItems, chatId)
      }).catch(async (e) => {
        logError('editMessageText_success', e);
        // A fallback when the edit fails (the original message being too old, say) - still send it, so the user never misses their product.
        await bot.sendMessage(chatId, successText, { parse_mode: 'HTML', reply_markup: successKeyboard(productId, variantId, orderId, deliveredItems, chatId) }).catch(() => {});
      });

      // Notify all admins
      // IMPORTANT: use HTML plus escapeHtml() here, NOT raw Markdown - a Telegram
      // username may contain an underscore ("_") and product/variant names are
      // free text typed by the admin (possibly containing *, _, `, [ and so on).
      // Sent raw with parse_mode 'Markdown', a single unpaired underscore or
      // symbol makes Telegram reject the message ("can't parse entities") - and
      // because there is a .catch(() => {}) below, that failure is SILENT, so the
      // admin would never learn a new order had come in (fatal specifically for
      // non-auto-delivery products that need the admin to send manually). This
      // escapeHtml() pattern is already used consistently in
      // formatDeliveryLogEntry()/buildSuccessText() - matched here.
      const username = query.from.username ? '@' + escapeHtml(query.from.username) : `ID ${chatId}`;
      // ===== BUG FIX: adminNote PREVIOUSLY only checked `deliverySource` (the name
      // of the source), NOT whether `deliveredItems` actually held anything.
      // The real case that hit this: canboso.purchase()/supplier.placeOrder()
      // SUCCEEDED (it did not throw, meaning the external API's balance/stock HAD
      // been deducted), but item extraction came back empty (the API response field
      // names for the "code/link/account" turning out to differ from what
      // purchase() assumed - exactly the stock-field bug pattern fixed earlier, but
      // this time for the product CONTENT, which is far more serious).
      // Before this fix: the buyer had paid and saw the "will be sent manually"
      // message (see buildSuccessText above, which was already correct), BUT the
      // admin was told "No further action needed" - so NOBODY REALISED the order
      // was stuck, and the buyer could wait forever with no product even though
      // both their balance and the external API's balance had been charged. The
      // actual contents are now checked, not just the source name, and an empty
      // result from an external API raises a SPECIFIC flag (⚠️ high priority plus
      // the external API's Order ID) so the admin can check and send the product
      // themselves.
      const gotAutoItems = deliveredItems && deliveredItems.length > 0;
      // ===== BUG FIX: detect a PARTIAL result from an external API
      // (Supplier/Canboso) - different from the "completely empty" case above.
      // This happens when the external API succeeds but returns only SOME of the
      // items for the qty requested (a buyer orders 5 and the API can only deliver
      // 3 - whether because the remote stock was really lower than displayed or
      // for some other reason on their side). The buyer is STILL charged the full
      // `total` (computed from the qty requested, not the qty actually delivered -
      // see the `total` calculation above, BEFORE the API is called), while
      // receiving only part of the goods. Before this fix, the admin was never
      // told about that difference at all (it counted as "No further action
      // needed" as long as the items array was not empty).
      const isPartialFulfillment = gotAutoItems
        && (deliverySource === 'supplier_api' || deliverySource === 'canboso_api' || deliverySource === 'mixed_supplier' || deliverySource === 'mixed_canboso')
        && deliveredItems.length < qty;
      let adminNote;
      if (deliverySource === 'mixed_supplier' || deliverySource === 'mixed_canboso') {
        // ===== PATCH: combined partial fulfilment - part of the qty from local
        // manual stock (stockItems), the remainder ordered automatically from
        // Supplier/Canboso. Different from isPartialFulfillment below (which means
        // the API itself returned only part of what was ASKED of it) - here the
        // total MAY well match qty exactly, just from mixed sources, so the admin
        // is still told for transparency (in case two different places need
        // checking for an audit or complaint).
        const apiLabel = deliverySource === 'mixed_supplier' ? 'Supplier' : 'Canboso';
        adminNote = isPartialFulfillment
          ? `⚠️ <b>ACTION NEEDED (partial)</b>: the buyer ordered ${qty}, filled from local stock + ${apiLabel}, but only ${deliveredItems.length} were delivered in total (the buyer was still charged in full for ${qty}). ${apiLabel} Order ID: <code>${escapeHtml(String((supplierMeta && supplierMeta.supplierOrderId) || '-'))}</code>. Check and make up the shortfall manually, or refund the difference to the buyer.`
          : `✅ Auto-delivered (mixed: partly from local stock, the rest via the ${apiLabel} API). No further action needed.`;
      } else if (deliverySource === 'supplier_api') {
        adminNote = !gotAutoItems
          ? `⚠️ <b>ACTION NEEDED</b>: the Supplier API order SUCCEEDED (the store's supplier balance has been charged) but the bot FAILED to extract the product returned (the API response schema may have changed). Supplier Order ID: <code>${escapeHtml(String((supplierMeta && supplierMeta.supplierOrderId) || '-'))}</code>. Check the supplier dashboard, then send it to the buyer manually.`
          : isPartialFulfillment
          ? `⚠️ <b>ACTION NEEDED (partial)</b>: the buyer ordered ${qty}, the Supplier API returned only ${deliveredItems.length} item(s) (the buyer was still charged in full for ${qty}). Supplier Order ID: <code>${escapeHtml(String((supplierMeta && supplierMeta.supplierOrderId) || '-'))}</code>. Check and make up the shortfall manually, or refund the difference to the buyer.`
          : `Auto-delivered via the Supplier API (service_id: <code>${escapeHtml(variant.supplierServiceId)}</code>). No further action needed.`;
      } else if (deliverySource === 'canboso_api') {
        // ===== BUG FIX (continued): when extraction fails (!gotAutoItems), attach a
        // slice of Canboso's raw JSON response directly to this notification
        // (rather than merely "the response schema may differ") - so the admin (or
        // a developer this message is forwarded to) can see IMMEDIATELY which field
        // names Canboso really used for order_id/items, without opening a dashboard
        // or a separate debug tool. Capped at ~600 characters so it does not run
        // long in a Telegram notification, and HTML-escaped because it is raw
        // external JSON (which may contain < > &).
        const rawPreview = canbosoRawResult
          ? escapeHtml(JSON.stringify(canbosoRawResult).slice(0, 600))
          : '(no raw data)';
        adminNote = !gotAutoItems
          ? `⚠️ <b>ACTION NEEDED</b>: the Canboso API order SUCCEEDED (the Canboso wallet balance has been charged) but the bot FAILED to extract the product returned (the API response schema may differ from what was assumed). Canboso Order ID: <code>${escapeHtml(String((supplierMeta && supplierMeta.supplierOrderId) || '-'))}</code>. Check the supplier dashboard, then send it to the buyer manually.\n\n🐞 <b>Canboso raw response</b> (send this to a developer so the field mapping can be fixed):\n<code>${rawPreview}</code>`
          : isPartialFulfillment
          ? `⚠️ <b>ACTION NEEDED (partial)</b>: the buyer ordered ${qty}, the Canboso API returned only ${deliveredItems.length} item(s) (the buyer was still charged in full for ${qty}). Canboso Order ID: <code>${escapeHtml(String((supplierMeta && supplierMeta.supplierOrderId) || '-'))}</code>. Check and make up the shortfall manually, or refund the difference to the buyer.`
          : `Auto-delivered via the Canboso API (product_id: <code>${escapeHtml(String(variant.canbosoProductId))}</code>). No further action needed.`;
      } else if (deliverySource === 'local_auto') {
        adminNote = `✅ Auto-delivered (${deliveredItems.length} item(s) sent automatically). No further action needed.`;
      } else {
        adminNote = `📦 Please send the account/details to the user manually.`;
      }
      notifyAdmins(
        `🛎️ <b>New Order</b>\n\nUser: ${username} (${chatId})\nProduct: ${escapeHtml(product.name)} - ${escapeHtml(variant.label)}\nQuantity: ${qty}\nTotal: ${usd(total)}\nOrder ID: <code>${escapeHtml(orderId)}</code>\n\n${adminNote}`
      );
      } finally {
        pendingOrderConfirms.delete(chatId);
      }
    }

    bot.answerCallbackQuery(query.id).catch(() => {});
  } catch (err) {
    logError('callback_query', err);
    bot.answerCallbackQuery(query.id, { text: lang.t(chatId, 'generic_error') }).catch(() => {});
  }
});

// ================= TEXT MESSAGES (pending actions) =================

// Every pending-action type that ONLY an ADMIN may execute (entered through the
// /admin flow, already gated by isAdmin() at a single point in
// bot.on('callback_query', ...) - see the `data.startsWith('admin:')` guard).
// The bot.on('message', ...) handler below SHOULD only ever receive these pending
// types for an admin chatId (since only admin-gated code ever calls
// db.setPendingAction() with them). But the guard below is deliberately added as
// a REDUNDANT LAYER OF DEFENCE, so that if a bug or typo ever creeps into the
// admin code (a new feature, a refactor) that forgets to put setPendingAction()
// inside an admin-gated block, there is still one last barrier before a sensitive
// step (changing a user's balance, broadcasting to all users, changing
// products/store settings) could be executed by a NON-admin chatId - rather than
// relying on the assumption that "this type must be safe".
const ADMIN_ONLY_PENDING_TYPES = new Set([
  'set_emoji_id',
  'forcejoin_add_link', 'forcejoin_add_ref',
  'channelnotif_setchannel',
  'addproduct_name', 'addproduct_price', 'addproduct_desc',
  'addvariant_label', 'addvariant_price', 'addvariant_stock', 'addvariant_desc',
  'setprice_amount', 'setdesc_text', 'sethowto_text', 'setlogo_url', 'setemoji_capture', 'addstock_items', 'addstock_manual_qty',
  'set_tier_markup',
  'supplier_orderid_lookup',
  'checkorder_id',
  'addbalance_user', 'addbalance_amount',
  'backup_interval', 'backup_groupid',
  'broadcast_content',
  'maintenance_message',
  'listusers_search_id'
]);

// A shared helper: validate the destination Telegram username/ID BEFORE moving on
// to the confirmation page - used by Buy Stars, Buy Gift, Confess Gift, AND Sell
// Collectible Gift (all of which send to a Telegram username/ID, so one function
// serves them all rather than being duplicated per feature). It first sends a
// "🔎 Checking..." message (deleted again afterwards), then checks with Telegram
// via checkTargetExists() (userbot.js).
//
// Returns targetInfo { id, username, firstName, lastName, isBot } when the target
// is found and valid (not a bot). Returns null when it is not found or turns out
// to be a bot account - in which case this function has ALREADY sent the right
// error message to the user, so the caller can simply `if (!targetInfo) return;`.
async function verifyTelegramTarget(chatId, target) {
  const checkingMsg = await bot.sendMessage(
    chatId, `🔎 Checking <code>${escapeHtml(target)}</code> on Telegram...`, { parse_mode: 'HTML' }
  );
  let targetInfo;
  try {
    targetInfo = await userbot.checkTargetExists(target);
  } catch (err) {
    await bot.deleteMessage(chatId, checkingMsg.message_id).catch(() => {});
    logError('verifyTelegramTarget', err);
    await bot.sendMessage(chatId,
      `❌ The username/ID <code>${escapeHtml(target)}</code> was not found on Telegram.\n\n` +
      `Possible reasons: a typo, the account does not exist or is private, or (for a numeric ID specifically) the target has never interacted with this store's userbot.\n\n` +
      `Send the correct username/ID again (without @), or /cancel to abort.`,
      { parse_mode: 'HTML' }
    );
    return null;
  }
  await bot.deleteMessage(chatId, checkingMsg.message_id).catch(() => {});

  if (targetInfo.isBot) {
    await bot.sendMessage(chatId,
      `⚠️ <code>${escapeHtml(target)}</code> is a BOT account, not a regular user. Gifts/Stars cannot be sent to a bot account.\n\n` +
      `Send the correct user's username/ID again, or /cancel to abort.`,
      { parse_mode: 'HTML' }
    );
    return null;
  }

  const displayName = targetInfo.username
    ? `@${targetInfo.username}`
    : ([targetInfo.firstName, targetInfo.lastName].filter(Boolean).join(' ') || target);
  await bot.sendMessage(chatId, `✅ Found: <b>${escapeHtml(displayName)}</b>`, { parse_mode: 'HTML' });
  return targetInfo;
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (msg.text && msg.text.startsWith('/')) return;

  const pending = db.getPendingAction(chatId);
  if (!pending) return;

  // An extra layer of defence (see the ADMIN_ONLY_PENDING_TYPES comment above):
  // when the pending action is an admin-only type BUT this chatId is not an admin,
  // clear it quietly and stop here - do NOT continue to any step below.
  // ke step manapun di bawah.
  if (ADMIN_ONLY_PENDING_TYPES.has(pending.type) && !isAdmin(chatId)) {
    db.clearPendingAction(chatId);
    return;
  }

  // The Maintenance Mode gate: while the feature is on, a non-admin user in the
  // MIDDLE of a pending action (typing a custom quantity or a topup amount, say)
  // is stopped here - their pending action is cancelled so it does not get stuck,
  // and they are simply shown the maintenance message.
  if (!isAdmin(chatId) && db.getMaintenanceSettings().enabled) {
    db.clearPendingAction(chatId);
    return bot.sendMessage(chatId, buildMaintenanceText(chatId), { parse_mode: 'HTML' });
  }

  // Broadcast accepts a PHOTO (with an optional caption) OR plain text - unlike
  // every other pending action below, which only accepts text - so it is handled
  // separately BEFORE the "must have msg.text" guard below.
  if (pending.type === 'broadcast_content') {
    return handleBroadcastContent(msg, chatId);
  }

  if (!msg.text) return;

  if (pending.type === 'custom_qty') {
    const qty = parseInt(msg.text.replace(/\D/g, ''), 10);
    const { productId, variantId } = pending.data;
    if (!qty || qty <= 0) {
      return bot.sendMessage(chatId, lang.t(chatId, 'invalid_qty_number'));
    }
    db.clearPendingAction(chatId);
    showOrderConfirmation(chatId, null, productId, variantId, qty);
  }

  else if (pending.type === 'topup_qris_amount') {
    const amount = parseFloat(msg.text.replace(/[^0-9.]/g, ''));
    const minUsd = await getMinQrisUsd();
    if (!amount || amount < minUsd) {
      return bot.sendMessage(chatId, lang.t(chatId, 'pending_min_amount', { min: usd(minUsd, chatId) }));
    }
    if (amount > MAX_TOPUP_AMOUNT) {
      return bot.sendMessage(chatId, lang.t(chatId, 'pending_max_amount', { max: usd(MAX_TOPUP_AMOUNT, chatId) }));
    }
    db.clearPendingAction(chatId);
    startQrisTopup(chatId, amount);
  }

  else if (pending.type === 'topup_usdt_amount') {
    const amount = parseFloat(msg.text.replace(/[^0-9.]/g, ''));
    if (!amount || amount < MIN_TOPUP_USDT_AMOUNT) {
      return bot.sendMessage(chatId, lang.t(chatId, 'pending_min_amount_generic', { min: usd(MIN_TOPUP_USDT_AMOUNT, chatId) }));
    }
    if (amount > MAX_TOPUP_AMOUNT) {
      return bot.sendMessage(chatId, lang.t(chatId, 'pending_max_amount', { max: usd(MAX_TOPUP_AMOUNT, chatId) }));
    }
    db.clearPendingAction(chatId);
    startUsdtTopup(chatId, amount);
  }

  else if (pending.type === 'topup_ton_amount') {
    const amount = parseFloat(msg.text.replace(/[^0-9.]/g, ''));
    if (!amount || amount < MIN_TOPUP_TON_AMOUNT) {
      return bot.sendMessage(chatId, lang.t(chatId, 'pending_min_amount_generic', { min: usd(MIN_TOPUP_TON_AMOUNT, chatId) }));
    }
    if (amount > MAX_TOPUP_AMOUNT) {
      return bot.sendMessage(chatId, lang.t(chatId, 'pending_max_amount', { max: usd(MAX_TOPUP_AMOUNT, chatId) }));
    }
    db.clearPendingAction(chatId);
    startTonTopup(chatId, amount);
  }

  else if (pending.type === 'topup_binance_amount') {
    const amount = parseFloat(msg.text.replace(/[^0-9.]/g, ''));
    if (!amount || amount < MIN_TOPUP_BINANCE_AMOUNT) {
      return bot.sendMessage(chatId, lang.t(chatId, 'pending_min_amount_generic', { min: usd(MIN_TOPUP_BINANCE_AMOUNT, chatId) }));
    }
    if (amount > MAX_TOPUP_AMOUNT) {
      return bot.sendMessage(chatId, lang.t(chatId, 'pending_max_amount', { max: usd(MAX_TOPUP_AMOUNT, chatId) }));
    }
    db.clearPendingAction(chatId);
    startBinanceTopup(chatId, amount);
  }

  else if (pending.type === 'gift_target') {
    const target = msg.text.trim().replace(/^@/, '');
    if (!target || target.length < 3) {
      return bot.sendMessage(chatId, lang.t(chatId, 'gift_invalid_target'), { parse_mode: 'HTML' });
    }
    const targetInfo = await verifyTelegramTarget(chatId, target);
    if (!targetInfo) return;
    const { mode, giftId, stars } = pending.data;
    if (mode === 'confess') {
      db.setPendingAction(chatId, { type: 'gift_message', data: { mode, giftId, stars, target } });
      return bot.sendMessage(chatId, lang.t(chatId, 'gift_ask_message'));
    }
    return showGiftConfirmation(chatId, { mode, giftId, stars, target, message: null });
  }

  else if (pending.type === 'gift_message') {
    const message = msg.text.trim().slice(0, 250);
    const { mode, giftId, stars, target } = pending.data;
    return showGiftConfirmation(chatId, { mode, giftId, stars, target, message });
  }

  else if (pending.type === 'recover_order_id') {
    const orderId = msg.text.trim();
    db.clearPendingAction(chatId);
    const order = db.getOrderById(orderId);
    if (!order || order.chatId !== chatId) {
      return bot.sendMessage(chatId, lang.t(chatId, 'recover_order_not_found', { orderId: escapeHtml(orderId) }), { parse_mode: 'Markdown' });
    }
    if (!order.delivered || !order.deliveredItems || !order.deliveredItems.length) {
      return bot.sendMessage(chatId, lang.t(chatId, 'recover_no_items', { orderId: escapeHtml(orderId) }), { parse_mode: 'Markdown' });
    }
    const product = db.findProduct(order.productId);
    const variant = product ? product.variants.find(v => v.id === order.variantId) : null;
    const label = product ? `${product.name}${variant && variant.label ? ' - ' + variant.label : ''}` : order.productId;
    bot.sendMessage(
      chatId,
      `🏅 <b>${lang.t(chatId, 'recover_result_title')}</b>\n\n📦 ${escapeHtml(label)} (x${order.qty})\n\n` +
      order.deliveredItems.map((item, i) => formatStockItem(item, i, chatId)).join('\n\n'),
      {
        parse_mode: 'HTML',
        reply_markup: hasLiveTotpSecret(order.deliveredItems)
          ? { inline_keyboard: [[withButtonIcon({ text: lang.t(chatId, 'btn_refresh_2fa'), callback_data: `refresh2fa:recover:${orderId}` }, 'refresh_2fa')]] }
          : undefined
      }
    );
  }

  else if (pending.type === 'set_emoji_id') {
    const entities = msg.entities || msg.caption_entities || [];
    const found = entities.find(e => e.type === 'custom_emoji' && e.custom_emoji_id);
    if (!found) {
      return bot.sendMessage(chatId, '⚠️ No custom emoji was found in that message. Make sure you send or forward a message that genuinely contains a *premium emoji* (picked from your Telegram Premium emoji panel), not just a plain unicode emoji. Type /cancel to abort.', { parse_mode: 'Markdown' });
    }
    const { scope, key } = pending.data;
    db.setEmojiId(`${scope}:${key}`, found.custom_emoji_id);
    db.clearPendingAction(chatId);
    // Preview it directly with the <tg-emoji> HTML tag (rather than only showing
    // the raw ID) so the admin sees the result immediately without opening another
    // menu first.
    const preview = `<tg-emoji emoji-id="${found.custom_emoji_id}">🎁</tg-emoji>`;
    bot.sendMessage(
      chatId,
      `✅ Emoji ID set successfully!\n\n` +
      `${preview} Preview\n` +
      `🆔 ID: <code>${found.custom_emoji_id}</code>\n\n` +
      `Open the related menu to see it in action.`,
      { parse_mode: 'HTML' }
    );
  }

  else if (pending.type === 'forcejoin_add_link') {
    const link = msg.text.trim();
    if (!/^https?:\/\/t\.me\//i.test(link)) {
      return bot.sendMessage(chatId, '⚠️ Invalid link. Make sure it starts with `https://t.me/...`. Type /cancel to abort.', { parse_mode: 'Markdown' });
    }
    db.setPendingAction(chatId, { type: 'forcejoin_add_ref', data: { link } });
    await bot.sendMessage(
      chatId,
      '➕ *Add a Force-Join Channel/Group*\n\n*Step 2/2* - Send the *channel/group username* (for example `@channelname`) OR the *Chat ID* (for example `-1001234567890`).\n\n' +
      '💡 For a *private* channel/group (with no public username), a numeric Chat ID is REQUIRED, and the bot must already be an *admin* there so it can check members\' join status. How to get the Chat ID: forward any message from that channel/group to @userinfobot / @RawDataBot.\n\nType /cancel to abort.',
      { parse_mode: 'Markdown' }
    );
  }

  else if (pending.type === 'forcejoin_add_ref') {
    let ref = msg.text.trim();
    if (!ref) return bot.sendMessage(chatId, '⚠️ Empty input. Type /cancel to abort.');
    // Normalise: numeric (a leading minus is allowed) -> Number; otherwise make
    // sure it starts with "@" (a channel username).
    if (/^-?\d+$/.test(ref)) {
      ref = Number(ref);
    } else {
      ref = ref.replace(/^@?/, '@');
    }
    const { link } = pending.data;
    db.clearPendingAction(chatId);

    // Auto-detect the channel title straight from Telegram (where possible) - so
    // the admin does not have to retype the channel name by hand.
    let title = String(ref);
    try {
      const chat = await bot.getChat(ref);
      if (chat && chat.title) title = chat.title;
    } catch (err) {
      // The bot may not be an admin/member of that channel yet - carry on and save
      // the chatRef as the title; the admin can check again manually later.
    }

    const channel = db.addForceJoinChannel({ title, link, chatRef: ref });
    await bot.sendMessage(
      chatId,
      `✅ *Channel/Group added successfully!*\n\n📢 *${channel.title}*\n🔗 ${channel.link}\n🆔 \`${channel.chatRef}\`\n\n` +
      `⚠️ Make sure the bot is already an *admin* in this channel/group so join detection is accurate. Turn the "Force Join" feature on via /admin -> 🔐 Force Join Channel/Group if it is not enabled yet.`,
      { parse_mode: 'Markdown', reply_markup: adminForceJoinKeyboard() }
    );
  }

  else if (pending.type === 'channelnotif_setchannel') {
    let ref = msg.text.trim();
    if (!ref) return bot.sendMessage(chatId, '⚠️ Empty input. Type /cancel to abort.');
    // Normalise: numeric (a leading minus is allowed) -> Number; otherwise make
    // sure it starts with "@" (a channel/group username) - as in forcejoin_add_ref.
    if (/^-?\d+$/.test(ref)) {
      ref = Number(ref);
    } else {
      ref = ref.replace(/^@?/, '@');
    }
    db.clearPendingAction(chatId);

    // Auto-detect the channel title straight from Telegram (where possible) - so
    // the admin does not have to retype the channel name by hand.
    let title = String(ref);
    try {
      const chat = await bot.getChat(ref);
      if (chat && chat.title) title = chat.title;
    } catch (err) {
      // The bot may not be an admin/member of that channel yet - carry on and save
      // the chatRef as the title; the admin can check again manually later.
    }

    const settings = db.setChannelNotifSettings({ chatRef: ref, title });
    await bot.sendMessage(
      chatId,
      `✅ *Notification destination channel set successfully!*\n\n📢 *${title}*\n🆔 \`${ref}\`\n\n` +
      `⚠️ Make sure the bot is already an *admin* in this channel/group, otherwise notifications will fail to send. Turn this feature on via /admin -> 📣 Set Channel Notifications -> 🟢 Enable Notifications if it is not enabled yet.`,
      { parse_mode: 'Markdown', reply_markup: adminChannelNotifKeyboard() }
    );
  }

  else if (pending.type === 'addproduct_name') {
    const raw = msg.text || '';
    // Look for a premium emoji the owner picked from their Telegram Premium panel
    // (a custom_emoji entity) in this product-name message. Take only the FIRST as
    // the product icon, then strip it from the text so the name stays clean.
    const customEntities = (msg.entities || [])
      .filter(e => e.type === 'custom_emoji')
      .sort((a, b) => a.offset - b.offset);
    let emoji = null;
    let emojiId = null;
    let nameText = raw;
    if (customEntities.length) {
      const ent = customEntities[0];
      const start = ent.offset;
      const end = ent.offset + ent.length;
      emoji = raw.slice(start, end);
      emojiId = ent.custom_emoji_id;
      nameText = raw.slice(0, start) + raw.slice(end);
    }
    const name = nameText.trim();
    if (!name) return bot.sendMessage(chatId, '⚠️ The product name cannot be empty.');
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || ('product-' + Date.now());
    db.setPendingAction(chatId, { type: 'addproduct_price', data: { name, id, emoji, emojiId } });
    const emojiNote = emojiId
      ? '\n\n✅ A premium emoji was detected and will be used as this product\'s icon.'
      : '\n\n⚠️ No premium emoji detected, so the product will use the default 📦 icon.'
    bot.sendMessage(chatId, `Price of *"${name}"* in USD? (numbers only, decimals allowed, for example \`6\` or \`5.99\`)${emojiNote}`, { parse_mode: 'Markdown' });
  }
  else if (pending.type === 'addproduct_price') {
    const price = parseFloat(msg.text.replace(/[^0-9.]/g, ''));
    if (!price) return bot.sendMessage(chatId, '⚠️ Enter a valid price in USD (numbers only, decimals allowed), for example: 5.99');
    db.setPendingAction(chatId, { type: 'addproduct_desc', data: { ...pending.data, price } });
    bot.sendMessage(chatId,
      'Product description? (free text, multiple lines are fine, and HTML tags such as `<b>...</b>` work for bold. If you pick a premium emoji straight from your own Telegram Premium panel, it is saved as premium automatically)\n\n' +
      'Example:\n`Genuine Gemini AI Pro account\nActive straight away on your Gmail\n24-hour warranty after the link is delivered`\n\n' +
      'Type `-` to skip for now (it can be filled in later in data/db.json).',
      { parse_mode: 'Markdown' }
    );
  }
  else if (pending.type === 'addproduct_desc') {
    const { name, id, price, emoji, emojiId } = pending.data;
    const typed = embedOwnerCustomEmoji(msg);
    const description = typed === '-' ? '' : typed;
    const result = db.addSimpleProduct(id, name, price, description, emoji, emojiId);
    db.clearPendingAction(chatId);
    if (!result) {
      return bot.sendMessage(chatId, `⚠️ A product with the id "${id}" already exists (a similar name is probably in use). Try ➕ Add Product again with a different name.`);
    }
    const iconHtml = emojiId ? `<tg-emoji emoji-id="${emojiId}">${emoji || '📦'}</tg-emoji>` : (emoji || '📦');
    bot.sendMessage(chatId,
      `✅ <b>Product ${iconHtml} ${escapeHtml(name)} created successfully!</b>\n\n` +
      `💰 Price: ${usd(price)}\n` +
      `📦 Current stock: 0\n\n` +
      `Next, add stock via /admin → 📥 Add Stock, so it can be delivered automatically as soon as someone buys.`,
      { parse_mode: 'HTML' }
    );
  }
  else if (pending.type === 'addvariant_label') {
    const label = msg.text.trim();
    db.setPendingAction(chatId, { type: 'addvariant_price', data: { ...pending.data, label } });
    bot.sendMessage(chatId, `Variant price in USD? (numbers only, decimals allowed, for example 15 or 14.99)`);
  }
  else if (pending.type === 'addvariant_price') {
    const price = parseFloat(msg.text.replace(/[^0-9.]/g, ''));
    if (!price) return bot.sendMessage(chatId, '⚠️ Enter a valid price in USD (decimals allowed).');
    db.setPendingAction(chatId, { type: 'addvariant_stock', data: { ...pending.data, price } });
    bot.sendMessage(chatId, 'How much stock is available? (numbers only, for example: 500)');
  }
  else if (pending.type === 'addvariant_stock') {
    const stock = parseInt(msg.text.replace(/\D/g, ''), 10) || 0;
    db.setPendingAction(chatId, { type: 'addvariant_desc', data: { ...pending.data, stock } });
    bot.sendMessage(chatId, 'Product description for this variant? (multiple lines are fine; type `-` to leave it empty for now)', { parse_mode: 'Markdown' });
  }
  // BUG FIX: the "Add Variant" flow used to stop at addvariant_stock and call
  // db.addVariant() without ever asking for a description - unlike "Add Product"
  // (addproduct_desc), which always asks. As a result the 2nd, 3rd and later
  // variants of a multi-variant product ALWAYS appeared with no description on the
  // product page (falling back to generic price/stock text), even though the admin
  // assumed they had entered one via "Add Product" at the start (which only saved
  // it on the default variant, not the new one). This flow now asks for a
  // description too, just like Add Product.
  else if (pending.type === 'addvariant_desc') {
    const typed = embedOwnerCustomEmoji(msg);
    const description = typed === '-' ? '' : typed;
    const { productId, label, price, stock } = pending.data;
    const variantId = productId + '-' + label.toLowerCase().replace(/\s+/g, '-');
    const ok = db.addVariant(productId, variantId, label, price, stock, description);
    db.clearPendingAction(chatId);
    if (!ok) {
      return bot.sendMessage(chatId, `⚠️ A variant labelled "${label}" seems to already exist on this product (the id "${variantId}" is taken). Try again with a different label.`);
    }
    bot.sendMessage(chatId, `✅ Variant "${label}" (${usd(price)}/pcs, stock ${stock}) added to product "${productId}".\n\nWant to set tiered bulk discounts? Edit the "tiers" section directly in data/db.json.`);
  }

  else if (pending.type === 'setprice_amount') {
    const price = parseFloat(msg.text.replace(/[^0-9.]/g, ''));
    if (!price) return bot.sendMessage(chatId, '⚠️ Enter a valid price in USD (numbers only, decimals allowed), for example: 5.99');
    const { productId, variantId } = pending.data;
    const product = db.findProduct(productId);
    const variant = product && product.variants.find(v => v.id === variantId);
    db.clearPendingAction(chatId);
    if (!variant) {
      return bot.sendMessage(chatId, '⚠️ Product/variant not found, cancelled.');
    }
    db.setVariantPrice(productId, variantId, price);
    const label = variant.label && variant.label !== product.name ? `${product.name} - ${variant.label}` : product.name;
    // When this variant is linked to the Supplier API, also show the latest margin
    // (supplier cost vs the new sale price) so the admin immediately sees the
    // profit or loss without opening the Supplier API menu again.
    const marginLine = variant.supplierServiceId ? `\n\n${marginText(variant.supplierCost, price)}` : '';
    bot.sendMessage(chatId, `✅ The price of *${label}* was changed to ${usd(price)}/pcs.${marginLine}`, { parse_mode: 'Markdown' });
  }

  // Input "10,7,5" -> markup% for tiers 1-49 / 50-499 / 500+ FOR ONE variant
  // (overriding the global DEFAULT_SUPPLIER_TIER_MARKUP) - see the
  // 'suppliertiermarkup' callback handler above for context.
  else if (pending.type === 'set_tier_markup') {
    const { productId, variantId } = pending.data;
    const product = db.findProduct(productId);
    const variant = product && product.variants.find(v => v.id === variantId);
    if (!product || !variant) {
      db.clearPendingAction(chatId);
      return bot.sendMessage(chatId, '⚠️ Product/variant not found, cancelled.');
    }
    const parts = msg.text.split(',').map(s => s.trim());
    if (parts.length !== 3 || parts.some(p => p === '' || isNaN(Number(p)))) {
      return bot.sendMessage(chatId, '⚠️ Wrong format. Type 3 percentage numbers separated by commas, for example: `10,7,5`. Type /cancel to abort.', { parse_mode: 'Markdown' });
    }
    const [p1, p2, p3] = parts.map(Number);
    if ([p1, p2, p3].some(p => p < 0)) {
      return bot.sendMessage(chatId, '⚠️ A markup percentage cannot be negative. Type it again, for example: `10,7,5`. Type /cancel to abort.', { parse_mode: 'Markdown' });
    }
    db.clearPendingAction(chatId);
    const newMarkup = [
      { min: 1, max: 49, markupPct: p1 },
      { min: 50, max: 499, markupPct: p2 },
      { min: 500, max: null, markupPct: p3 }
    ];
    db.setVariantTierMarkup(productId, variantId, newMarkup);
    const label = variant.label && variant.label !== product.name ? `${product.name} - ${variant.label}` : product.name;
    const cost = variant.supplierCost;
    if (typeof cost !== 'number' || isNaN(cost) || cost <= 0) {
      // The markup is saved and will apply on the next sync, but cannot be
      // calculated NOW because the live cost is not yet known (this variant may
      // never have synced at all).
      return bot.sendMessage(chatId,
        `✅ 3-tier markup for *${label}* saved: ${p1}% / ${p2}% / ${p3}%.\n\n⚠️ The supplier cost is not known yet, so the tiers have NOT been calculated now - they will fill in automatically on the next sync (or click "🔄 Refresh Cost & Stock").`,
        { parse_mode: 'Markdown' }
      );
    }
    // Recalculate the tiers immediately from the CURRENT cost plus the new markup,
    // so buyers see the new price without waiting for the scheduled auto-sync.
    const newTiers = computeTiersFromCost(cost, newMarkup);
    db.setVariantTiers(productId, variantId, newTiers);
    bot.sendMessage(chatId,
      `✅ 3-tier markup for *${label}* saved and applied immediately!\n\n` +
      `Cost: ${usd(cost)}\nMarkup: ${p1}% / ${p2}% / ${p3}%\nNew price: ${tierPricesSummary(newTiers)}\n\n` +
      `This markup keeps applying on every subsequent sync (recalculating from the live cost each time).`,
      { parse_mode: 'Markdown' }
    );
  }

  // A gift markup percentage ("💲 Set Gift Pricing" -> "📈 Change Markup %") -
  // see giftPriceUsd() above for how it is used (by Buy Gift/Confess Gift AND
  // Sell Collectible Gift alike).
  else if (pending.type === 'set_gift_markup') {
    const value = Number(msg.text.trim().replace(',', '.'));
    if (isNaN(value) || value < 0) {
      return bot.sendMessage(chatId, '⚠️ The markup must be a number ≥ 0. Type it again, for example: `30`. Type /cancel to abort.', { parse_mode: 'Markdown' });
    }
    db.clearPendingAction(chatId);
    db.setGiftPricingSettings({ markupPct: value });
    bot.sendMessage(chatId, `✅ The gift markup was changed to *${value}%*.`, { parse_mode: 'Markdown' });
  }

  // The Stars->USD gift rate ("💲 Set Gift Pricing" -> "💱 Change Stars→USD
  // Rate") - used to work out the cost (stars x rate) before the markup% is
  // added, see giftPriceUsd().
  else if (pending.type === 'set_gift_stars_rate') {
    const value = Number(msg.text.trim().replace(',', '.'));
    if (isNaN(value) || value <= 0) {
      return bot.sendMessage(chatId, '⚠️ The rate must be a number greater than 0. Type it again, for example: `0.015`. Type /cancel to abort.', { parse_mode: 'Markdown' });
    }
    db.clearPendingAction(chatId);
    db.setGiftPricingSettings({ starsToUsdRate: value });
    bot.sendMessage(chatId, `✅ The gift Stars→USD rate was changed to *${value}* (1⭐ = $${value}).`, { parse_mode: 'Markdown' });
  }

  // Input "0.65,0.69,0.65" -> direct SALE prices (not percentages) for tiers
  // 1-49 / 50-499 / 500+ on one variant - see askSetTierPrice() for context.
  else if (pending.type === 'set_tier_price') {
    const { productId, variantId } = pending.data;
    const product = db.findProduct(productId);
    const variant = product && product.variants.find(v => v.id === variantId);
    if (!product || !variant) {
      db.clearPendingAction(chatId);
      return bot.sendMessage(chatId, '⚠️ Product/variant not found, cancelled.');
    }
    const parts = msg.text.split(',').map(s => s.trim());
    if (parts.length !== 3 || parts.some(p => p === '' || isNaN(Number(p)))) {
      return bot.sendMessage(chatId, '⚠️ Wrong format. Type 3 USD prices separated by commas, for example: `0.65,0.69,0.65`. Type /cancel to abort.', { parse_mode: 'Markdown' });
    }
    const [p1, p2, p3] = parts.map(Number);
    if ([p1, p2, p3].some(p => p <= 0)) {
      return bot.sendMessage(chatId, '⚠️ A price cannot be 0 or negative. Type it again, for example: `0.65,0.69,0.65`. Type /cancel to abort.', { parse_mode: 'Markdown' });
    }
    db.clearPendingAction(chatId);
    const newTiers = [
      { min: 1, max: 49, price: p1 },
      { min: 50, max: 499, price: p2 },
      { min: 500, max: null, price: p3 }
    ];
    db.setVariantTiers(productId, variantId, newTiers);
    const label = variant.label && variant.label !== product.name ? `${product.name} - ${variant.label}` : product.name;
    const supplierNote = variant.supplierServiceId
      ? (variant.priceLocked
          ? '\n\n🔒 This price is locked, so it is SAFE - the next Supplier sync will not overwrite it (cost and stock still update as usual).'
          : '\n\n⚠️ Remember: these tiers will be overwritten again as soon as the next Supplier sync runs. Reopen this menu and use "🔒 Lock Manual Price" if you do not want that.')
      : '';
    bot.sendMessage(chatId,
      `✅ The bulk discount tiers for *${label}* were updated!\n\nNew tiers: ${tierPricesSummary(newTiers)}${supplierNote}`,
      { parse_mode: 'Markdown' }
    );
  }

  else if (pending.type === 'supplier_orderid_lookup') {
    const orderId = msg.text.trim();
    if (!orderId) return bot.sendMessage(chatId, '⚠️ The Order ID cannot be empty. Type /cancel to abort.');
    db.clearPendingAction(chatId);
    if (!AIVERSEHUB_API_KEY) {
      return bot.sendMessage(chatId, '⚠️ *AIVERSEHUB_API_KEY* has not been set in `.env`.', { parse_mode: 'Markdown' });
    }
    let order;
    try {
      order = await supplier.getOrderById(orderId);
    } catch (err) {
      return bot.sendMessage(chatId, `⚠️ Failed to fetch the order from the supplier:\n_${err.message}_`, { parse_mode: 'Markdown' });
    }
    if (!order) {
      return bot.sendMessage(chatId, `🔍 Order ID \`${escapeHtml(orderId)}\` was not found at the supplier.`, { parse_mode: 'HTML' });
    }
    const delivered = Array.isArray(order.delivered_products) && order.delivered_products.length
      ? order.delivered_products.map(p => `<code>${escapeHtml(String(p))}</code>`).join('\n')
      : '_(none, or not delivered yet)_';
    bot.sendMessage(chatId,
      `🔍 <b>Supplier Order Details</b>\n\n` +
      `Order ID: <code>${escapeHtml(order.order_id)}</code>\n` +
      `Service: ${escapeHtml(order.service || '-')}\n` +
      `Quantity: ${order.quantity}\n` +
      `Amount: ${usd(order.amount || 0)}\n` +
      `Status: ${escapeHtml(order.status || '-')}\n\n` +
      `📦 Products delivered:\n${delivered}`,
      { parse_mode: 'HTML' }
    );
  }

  else if (pending.type === 'sethowto_text') {
    const text = embedOwnerCustomEmoji(msg);
    const { productId, variantId } = pending.data;
    const ok = db.setHowToUse(productId, variantId, text);
    db.clearPendingAction(chatId);
    if (!ok) {
      return bot.sendMessage(chatId, '⚠️ Product/variant not found, cancelled.');
    }
    const product = db.findProduct(productId);
    const variant = product && product.variants.find(v => v.id === variantId);
    bot.sendMessage(chatId,
      `✅ The *How to Use* text for *${product ? product.name : productId}${variant && variant.label ? ' - ' + variant.label : ''}* was saved.`,
      { parse_mode: 'Markdown' }
    );
  }

  else if (pending.type === 'setdesc_text') {
    const typed = embedOwnerCustomEmoji(msg);
    const text = typed === '-' ? '' : typed;
    const { productId, variantId } = pending.data;
    const ok = db.setDescription(productId, variantId, text);
    db.clearPendingAction(chatId);
    if (!ok) {
      return bot.sendMessage(chatId, '⚠️ Product/variant not found, cancelled.');
    }
    const product = db.findProduct(productId);
    const variant = product && product.variants.find(v => v.id === variantId);
    bot.sendMessage(chatId,
      `✅ Description for *${product ? product.name : productId}${variant && variant.label ? ' - ' + variant.label : ''}* saved successfully.`,
      { parse_mode: 'Markdown' }
    );
  }

  else if (pending.type === 'setlogo_url') {
    const { productId } = pending.data;
    const typed = (msg.text || '').trim();
    const product = db.findProduct(productId);
    if (!product) {
      db.clearPendingAction(chatId);
      return bot.sendMessage(chatId, '⚠️ Product not found, cancelled.');
    }
    if (typed === '-') {
      db.setProductLogo(productId, null);
      db.clearPendingAction(chatId);
      return bot.sendMessage(chatId, `✅ The logo for *${product.name}* was removed; it goes back to the plain emoji.`, { parse_mode: 'Markdown' });
    }
    if (!/^https?:\/\//i.test(typed)) {
      return bot.sendMessage(chatId, '⚠️ Invalid URL - it must start with `http://` or `https://`. Try again, or /cancel to abort.', { parse_mode: 'Markdown' });
    }
    db.setProductLogo(productId, typed);
    db.clearPendingAction(chatId);
    bot.sendMessage(chatId,
      `✅ The logo for *${product.name}* was saved. From now on the "🎉 New Purchase!" channel notification for this product uses this logo.`,
      { parse_mode: 'Markdown' }
    );
  }

  else if (pending.type === 'setemoji_capture') {
    const { productId } = pending.data;
    const product = db.findProduct(productId);
    if (!product) {
      db.clearPendingAction(chatId);
      return bot.sendMessage(chatId, '⚠️ Product not found, cancelled.');
    }
    const typed = (msg.text || '').trim();
    if (typed === '-') {
      db.setProductEmoji(productId, '📦', null);
      db.clearPendingAction(chatId);
      return bot.sendMessage(chatId, `✅ The icon for *${product.name}* was reverted to a plain unicode emoji (📦, no premium).`, { parse_mode: 'Markdown' });
    }
    // Find the FIRST custom_emoji entity in this message (a forward is fine) -
    // the same mechanism as the capture in "🎨 Manage Emoji ID" (see
    // pending.type === 'emoji_capture'). When none is found, ask again - do NOT
    // quietly accept plain unicode, so the admin does not wrongly believe it is
    // premium when it is only an ordinary character.
    const found = (msg.entities || []).find(e => e.type === 'custom_emoji');
    if (!found) {
      return bot.sendMessage(chatId,
        '⚠️ No custom emoji was found in that message. Make sure you send or forward a message that genuinely contains a *premium emoji* (picked from your Telegram Premium emoji panel), not just a plain unicode emoji. Type `-` to use plain unicode, or /cancel to abort.',
        { parse_mode: 'Markdown' }
      );
    }
    const fallbackChar = msg.text.slice(found.offset, found.offset + found.length);
    db.setProductEmoji(productId, fallbackChar, found.custom_emoji_id);
    db.clearPendingAction(chatId);
    bot.sendMessage(chatId,
      `✅ The emoji for *${product.name}* was changed!\n\n🆔 ID: \`${found.custom_emoji_id}\`\n\nCheck the product description page / channel notification to see the result.`,
      { parse_mode: 'Markdown' }
    );
  }

  else if (pending.type === 'addstock_items') {
    const { productId, variantId } = pending.data;
    const lines = msg.text.split('\n').map(s => s.trim()).filter(Boolean);
    if (!lines.length) {
      return bot.sendMessage(chatId, '⚠️ No links/codes were read. Send at least one line, or /cancel to abort.');
    }
    const result = db.addStockItems(productId, variantId, lines);
    if (!result) {
      db.clearPendingAction(chatId);
      return bot.sendMessage(chatId, '⚠️ Product/variant not found, cancelled.');
    }
    const product = db.findProduct(productId);
    const variant = product && product.variants.find(v => v.id === variantId);
    // The pending action is DELIBERATELY not cleared, so the admin can keep
    // sending more links/codes without reopening the menu. /cancel finishes.
    bot.sendMessage(chatId,
      `✅ *${result.added} link(s)/code(s)* added to *${product ? product.name : productId} - ${variant ? variant.label : variantId}*.\n\n` +
      `📦 Total stock ready for auto-delivery: *${result.total}*\n\n` +
      `🔔 A "New Stock Available!" notification is being sent to all users...\n\n` +
      `Send more to add further items, or /cancel when you are done.`,
      { parse_mode: 'Markdown' }
    );
    // Fire-and-forget - see the full comment on broadcastStockAlert().
    if (product && variant) {
      broadcastStockAlert(product, variant, result.added, chatId).catch(err => console.error('broadcastStockAlert error:', err.message));
    }
  }

  else if (pending.type === 'addstock_manual_qty') {
    const { productId, variantId } = pending.data;
    const qty = parseInt(msg.text.trim(), 10);
    if (!qty || isNaN(qty) || qty <= 0) {
      return bot.sendMessage(chatId, '⚠️ Type a valid number (greater than 0), or /cancel to abort.');
    }
    const result = db.addManualStock(productId, variantId, qty);
    if (!result) {
      db.clearPendingAction(chatId);
      return bot.sendMessage(chatId, '⚠️ Product/variant not found, cancelled.');
    }
    const product = db.findProduct(productId);
    const variant = product && product.variants.find(v => v.id === variantId);
    // The pending action is DELIBERATELY not cleared here either, as in
    // addstock_items - the admin can type another number to add more.
    bot.sendMessage(chatId,
      `✅ *${result.added} stock* added (manually) to *${product ? product.name : productId} - ${variant ? variant.label : variantId}*.\n\n` +
      `📦 Total stock now: *${result.total}*\n\n` +
      `🔔 A "New Stock Available!" notification is being sent to all users...\n\n` +
      `Type another number to add more, or /cancel when you are done.`,
      { parse_mode: 'Markdown' }
    );
    if (product && variant) {
      broadcastStockAlert(product, variant, result.added, chatId).catch(err => console.error('broadcastStockAlert error:', err.message));
    }
  }

  else if (pending.type === 'checkorder_id') {
    const orderId = msg.text.trim();
    const order = db.getOrderById(orderId);
    db.clearPendingAction(chatId);
    if (!order) {
      return bot.sendMessage(chatId, `⚠️ No order was found with the ID \`${orderId}\`.`, { parse_mode: 'Markdown' });
    }
    bot.sendMessage(chatId, formatDeliveryLogEntry(order), { parse_mode: 'HTML' });
  }

  else if (pending.type === 'listusers_search_id') {
    // Auto-detection: when the input contains letters -> search by USERNAME
    // (contains, case-insensitive, with or without a leading "@").
    // When the input is digits only -> search by Chat ID as before (contains, so
    // the admin can type just part of the number).
    const rawInput = msg.text.trim();
    const usernameQuery = rawInput.replace(/^@/, '').toLowerCase();
    const isUsernameSearch = /[a-zA-Z]/.test(rawInput);

    db.clearPendingAction(chatId);

    if (isUsernameSearch) {
      if (!usernameQuery) {
        return bot.sendMessage(chatId, '⚠️ Type a valid username. Try again via /admin -> 📋 User List -> 🔍 Search User (ID/Username).');
      }
      const matches = db.getUsersList().filter(u => u.username && u.username.toLowerCase().includes(usernameQuery));
      return bot.sendMessage(chatId, usersSearchResultText(matches, rawInput), { parse_mode: 'HTML', reply_markup: usersSearchResultKeyboard() });
    }

    const query = rawInput.replace(/\D/g, '');
    if (!query) {
      return bot.sendMessage(chatId, '⚠️ Type a valid Chat ID or username. Try again via /admin -> 📋 User List -> 🔍 Search User (ID/Username).');
    }
    const matches = db.getUsersList().filter(u => u.chatId.includes(query));
    bot.sendMessage(chatId, usersSearchResultText(matches, query), { parse_mode: 'HTML', reply_markup: usersSearchResultKeyboard() });
  }

  else if (pending.type === 'addbalance_user') {
    const targetId = msg.text.trim();
    db.setPendingAction(chatId, { type: 'addbalance_amount', data: { targetId } });
    bot.sendMessage(chatId, 'How much balance (USD) do you want to add? (numbers only, decimals allowed; a negative number subtracts)');
  }
  else if (pending.type === 'addbalance_amount') {
    const amount = parseFloat(msg.text.replace(/[^0-9.-]/g, ''));
    const { targetId } = pending.data;
    // Every other numeric input handler (addproduct_price, topup_*, custom_qty
    // and so on) validates the parse result before using it - this handler used to
    // be missed. Without this validation, an admin typo (just a space, or text
    // with no digits at all) makes parseFloat return NaN, and db.updateBalance()
    // then stores NaN as the user's balance -> that balance is PERMANENTLY BROKEN
    // (NaN plus anything stays NaN, uncorrectable through a normal topup or
    // purchase, fixable only by editing db.json by hand).
    if (isNaN(amount)) {
      db.clearPendingAction(chatId);
      return bot.sendMessage(chatId, '⚠️ Invalid amount (not a number). Cancelled - try again via /admin → 💰 Manage User Balance.');
    }
    const newBalance = db.updateBalance(targetId, amount);
    db.clearPendingAction(chatId);
    bot.sendMessage(chatId, `✅ The balance of user ${targetId} is now: ${usd(newBalance)}`);
    bot.sendMessage(targetId, `ℹ️ Your balance was adjusted by an admin. Current balance: *${usd(newBalance)}*`, { parse_mode: 'Markdown' }).catch(() => {});
  }

  else if (pending.type === 'backup_interval') {
    const minutes = parseInt(msg.text.replace(/\D/g, ''), 10);
    db.clearPendingAction(chatId);
    if (!minutes || minutes < 1) {
      return bot.sendMessage(chatId, '⚠️ Invalid interval. Type the number of minutes only, for example `60`. Try again via /admin -> 💾 Auto Backup -> ⏱️ Set Interval.', { parse_mode: 'Markdown' });
    }
    const settings = db.setBackupSettings({ intervalMinutes: minutes });
    scheduleBackup();
    bot.sendMessage(chatId, `✅ The backup interval was set to *${minutes} minutes*.`, { parse_mode: 'Markdown', reply_markup: backupMenuKeyboard(settings) });
  }

  else if (pending.type === 'backup_groupid') {
    const groupId = msg.text.trim();
    db.clearPendingAction(chatId);
    if (!/^-?\d+$/.test(groupId)) {
      return bot.sendMessage(chatId, '⚠️ The Group ID must be a number (a leading minus is allowed). For example: `-1001234567890`. Try again via /admin -> 💾 Auto Backup -> 🆔 Set Group ID.', { parse_mode: 'Markdown' });
    }
    const settings = db.setBackupSettings({ groupId });
    scheduleBackup();
    bot.sendMessage(chatId, `✅ The backup destination Group ID was set to \`${groupId}\`.\n\n⚠️ Make sure this bot is already a member of that group, otherwise backup delivery will fail.`, { parse_mode: 'Markdown', reply_markup: backupMenuKeyboard(settings) });
  }

  else if (pending.type === 'maintenance_message') {
    const text = embedOwnerCustomEmoji(msg);
    db.clearPendingAction(chatId);
    const settings = db.setMaintenanceSettings({ message: text });
    bot.sendMessage(chatId, `✅ The custom Maintenance Mode message was saved. Preview:`, { parse_mode: 'Markdown' });
    bot.sendMessage(chatId, text, { parse_mode: 'HTML' }).catch(err => {
      bot.sendMessage(chatId, `⚠️ The preview could not be displayed (usually because of invalid or unclosed HTML tags): ${err.message}\n\nThe message is still saved, but it is best to fix it via /admin -> 🛠️ Bot Maintenance -> ✏️ Set Custom Message.`);
    });
    bot.sendMessage(chatId, maintenanceMenuText(settings), { parse_mode: 'Markdown', reply_markup: maintenanceMenuKeyboard(settings) });
  }
});

// ================= AUTO BACKUP (zip the source code -> send it to a group) =================
// Feature: /admin -> 💾 Auto Backup. Builds a .zip holding the project's FULL
// source code (except node_modules and .npm - see backup.js) and sends it
// automatically to a Telegram group at the interval the admin configures. It can
// also be triggered manually via the "📤 Backup Now" button.

let backupTimer = null;

// (Re)start the timer from the latest settings in db.json. Called whenever the
// settings change (toggling on/off, changing the interval, changing the group id)
// and once more when the bot first starts.
function scheduleBackup() {
  if (backupTimer) {
    clearInterval(backupTimer);
    backupTimer = null;
  }
  const settings = db.getBackupSettings();
  if (settings.enabled && settings.groupId && settings.intervalMinutes > 0) {
    backupTimer = setInterval(() => {
      runBackupJob('scheduled').catch(() => {});
    }, settings.intervalMinutes * 60 * 1000);
  }
}

// Build the zip and send it to the group id set in settings. source: 'scheduled' | 'manual'.
// Returns { ok: true, sizeKb, fileName } or { ok: false, error }.
async function runBackupJob(source) {
  const settings = db.getBackupSettings();
  if (!settings.groupId) {
    return { ok: false, error: 'The Group ID has not been set.' };
  }
  let zipPath;
  try {
    const result = await backup.createBackupZip();
    zipPath = result.zipPath;
    const sizeKb = (result.sizeBytes / 1024).toFixed(1);
    const caption =
      `💾 <b>Auto Backup - Source Code</b>\n` +
      `📅 ${new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'medium' })}\n` +
      `📦 Size: ${sizeKb} KB\n` +
      `🔖 Triggered: ${source === 'scheduled' ? 'Automatically (scheduled)' : 'Manually by an admin'}`;
    await bot.sendDocument(settings.groupId, zipPath, { caption, parse_mode: 'HTML' }, { filename: result.fileName, contentType: 'application/zip' });
    backup.cleanupBackupFile(zipPath);
    return { ok: true, sizeKb, fileName: result.fileName };
  } catch (err) {
    console.error('Auto backup failed:', err.message);
    if (zipPath) backup.cleanupBackupFile(zipPath);
    // Tell every admin when a scheduled backup fails (the bot not being a member
    // of the group, or a wrong Group ID), so it does not stop silently.
    ADMIN_IDS.forEach(id => {
      bot.sendMessage(id, `⚠️ The auto backup could not be sent to group \`${settings.groupId}\`:\n${err.message}\n\nMake sure the bot is a member (ideally an admin) of that group, and that the Group ID is correct.`, { parse_mode: 'Markdown' }).catch(() => {});
    });
    return { ok: false, error: err.message };
  }
}

function backupMenuText(settings) {
  const statusText = settings.enabled ? '🟢 Active' : '🔴 Inactive';
  const interval = settings.intervalMinutes || 60;
  const intervalText = (interval >= 60 && interval % 60 === 0) ? `${interval / 60} hour(s)` : `${interval} minutes`;
  const groupText = settings.groupId ? `\`${settings.groupId}\`` : '⚠️ not set yet';
  return (
    `💾 *Auto Backup*\n\n` +
    `Status: ${statusText}\n` +
    `Interval: every *${intervalText}*\n` +
    `Send to Group ID: ${groupText}\n\n` +
    `The backup holds the *full project source code* (except \`node_modules\` and \`.npm\`) in a single \`.zip\`, sent automatically to the group above. Make sure the bot has been added as a member of the destination group.`
  );
}

function backupMenuKeyboard(settings) {
  return {
    inline_keyboard: [
      [{ text: settings.enabled ? '⏸️ Disable' : '▶️ Enable', callback_data: 'admin:backup:toggle' }],
      [{ text: '⏱️ Set Interval', callback_data: 'admin:backup:setinterval' }],
      [{ text: '🆔 Set Group ID', callback_data: 'admin:backup:setgroup' }],
      [{ text: '📤 Backup Now', callback_data: 'admin:backup:now' }],
      [withButtonIcon({ text: '‹ Back', callback_data: 'admin:cat_settings' }, 'back')],
      [withButtonIcon({ text: '🏠 Main Menu', callback_data: 'admin:menu' }, 'admin_menu_utama')]
    ]
  };
}

// ================= BOT MAINTENANCE MODE =================
// Triggered from /admin -> 🛠️ Bot Maintenance. When enabled, ALL non-admin users
// are blocked from every bot interaction (see the maintenance gates in /start,
// the main bot.on('callback_query', ...), and bot.on('message', ...)) and are
// shown a single maintenance message - admins always keep normal access. The
// default message already looks good and is full of Premium emoji (borrowed from
// emoji that ALREADY EXIST in other files, see buildMaintenanceText() and
// emoji-id-teks.js), or the admin can write their own via "✏️ Set Custom
// Message".
function maintenanceMenuText(settings) {
  const statusText = settings.enabled ? '🟢 Active (non-admin users blocked)' : '🔴 Inactive';
  const msgText = settings.message ? '✏️ Custom (set by an admin)' : '✨ Default (auto Premium emoji)';
  return (
    `🛠️ *Bot Maintenance*\n\n` +
    `Status: ${statusText}\n` +
    `Message: ${msgText}\n\n` +
    `While it is on, every user except admins is locked out of all bot features - they only see the single maintenance message below. Use the "👀 Preview Message" button to see it.`
  );
}

function maintenanceMenuKeyboard(settings) {
  const rows = [
    [{ text: settings.enabled ? '🔴 Disable' : '🟢 Enable', callback_data: 'admin:maintenance_toggle' }],
    [{ text: '👀 Preview Message', callback_data: 'admin:maintenance_preview' }],
    [{ text: '✏️ Set Custom Message', callback_data: 'admin:maintenance_setmsg' }]
  ];
  if (settings.message) {
    rows.push([{ text: '↩️ Use the Default Message Again', callback_data: 'admin:maintenance_resetmsg' }]);
  }
  rows.push([{ text: '🎨 Manage Default Message Emoji', callback_data: 'admin:emojiteksgroup:maintenance' }]);
  rows.push([withButtonIcon({ text: '‹ Back', callback_data: 'admin:cat_settings' }, 'back')]);
  rows.push([withButtonIcon({ text: '🏠 Main Menu', callback_data: 'admin:menu' }, 'admin_menu_utama')]);
  return { inline_keyboard: rows };
}

// ================= USER LIST =================
// Triggered from /admin -> 📋 User List. Shown paginated (10 users per page) so
// it stays light and readable even with hundreds or thousands of users - the data
// comes straight from db.getUsersList() (see db.js).
const USERS_PAGE_SIZE = 10;

function usersListText(page) {
  const allUsers = db.getUsersList();
  if (!allUsers.length) {
    return { text: '📋 <b>User List</b>\n\n<i>No user has pressed /start on the bot yet.</i>', totalPages: 1, page: 1, totalUsers: 0 };
  }
  const totalPages = Math.max(1, Math.ceil(allUsers.length / USERS_PAGE_SIZE));
  const actualPage = Math.min(Math.max(1, page), totalPages);
  const start = (actualPage - 1) * USERS_PAGE_SIZE;
  const pageUsers = allUsers.slice(start, start + USERS_PAGE_SIZE);
  // IMPORTANT: use HTML (not Markdown) plus escapeHtml() on the username - a
  // Telegram username can contain anything ("_", "*", "`", "[" and so on), and
  // sent as is with parse_mode Markdown those characters are read by Telegram as
  // formatting markers that never close (a single unpaired underscore, say) ->
  // making the API return a 400 "can't parse entities". HTML is far safer here
  // because only < > & need escaping (see escapeHtml()), making a clash with
  // characters that legitimately appear in a username far less likely.
  //
  const lines = pageUsers.map(u => {
    const usernameText = u.username ? `@${escapeHtml(u.username)}` : '<i>(no username)</i>';
    return (
      `👤 <code>${escapeHtml(u.chatId)}</code> - ${usernameText}\n` +
      `   💰 ${usd(u.balance)} • 🧾 ${u.orderCount} order(s) • 🎁 ${u.referralCount} referral(s)`
    );
  }).join('\n\n');
  return {
    text: `📋 <b>User List</b> (page ${actualPage}/${totalPages}, ${allUsers.length} users in total)\n\n${lines}`,
    totalPages,
    page: actualPage,
    totalUsers: allUsers.length
  };
}

function usersListKeyboard(page, totalPages) {
  const navRow = [];
  if (page > 1) navRow.push({ text: '‹ Previous', callback_data: `admin:listusers:${page - 1}` });
  if (page < totalPages) navRow.push({ text: 'Next ›', callback_data: `admin:listusers:${page + 1}` });
  const rows = [];
  if (navRow.length) rows.push(navRow);
  rows.push([{ text: '🔍 Search User (ID/Username)', callback_data: 'admin:listusers_search' }]);
  rows.push([withButtonIcon({ text: '‹ Back', callback_data: 'admin:cat_users' }, 'back')]);
  rows.push([withButtonIcon({ text: '🏠 Main Menu', callback_data: 'admin:menu' }, 'admin_menu_utama')]);
  return { inline_keyboard: rows };
}

// Search results for /admin -> 📋 User List -> 🔍 Search User (ID). It matches
// on CONTAINS (not just an exact match) against the Chat ID - admins often
// remember only PART of the number (from a new-order notification where the chat
// id is partly masked), which makes it more useful than exact matching. It is
// capped at 20 results per search so the message does not run long when the query
// is too short or generic (just "1", say).
const USERS_SEARCH_RESULT_LIMIT = 20;

function usersSearchResultText(matches, query) {
  const safeQuery = escapeHtml(query);
  if (!matches.length) {
    return `🔍 <b>Search User</b>\n\nNo user has a Chat ID containing <code>${safeQuery}</code>.`;
  }
  const capped = matches.slice(0, USERS_SEARCH_RESULT_LIMIT);
  const lines = capped.map(u => {
    const usernameText = u.username ? `@${escapeHtml(u.username)}` : '<i>(no username)</i>';
    return (
      `👤 <code>${escapeHtml(u.chatId)}</code> - ${usernameText}\n` +
      `   💰 ${usd(u.balance)} • 🧾 ${u.orderCount} order(s) • 🎁 ${u.referralCount} referral(s)`
    );
  }).join('\n\n');
  const moreNote = matches.length > capped.length
    ? `\n\n<i>…and ${matches.length - capped.length} more users - try typing a longer or more specific ID.</i>`
    : '';
  return `🔍 <b>User Search Results</b> (containing <code>${safeQuery}</code>, ${matches.length} found)\n\n${lines}${moreNote}`;
}

function usersSearchResultKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🔍 Search Again', callback_data: 'admin:listusers_search' }],
      [{ text: '‹ Back to User List', callback_data: 'admin:listusers:1' }]
    ]
  };
}

// ================= BROADCAST (text / photo+caption to all users) =================
// Triggered from /admin -> 📢 Broadcast. The owner sends one message (text OR a
// photo with or without a caption) -> the bot stores it temporarily and shows a
// PREVIEW exactly as users will receive it -> the owner confirms via a button ->
// only then is it sent to every chat ID in the database.
async function handleBroadcastContent(msg, chatId) {
  let content;
  if (msg.photo && msg.photo.length) {
    const largest = msg.photo[msg.photo.length - 1]; // the highest resolution is the last element
    const caption = msg.caption ? embedOwnerCustomEmojiFrom(msg.caption, msg.caption_entities) : '';
    content = { kind: 'photo', fileId: largest.file_id, caption };
  } else if (msg.text) {
    content = { kind: 'text', text: embedOwnerCustomEmoji(msg) };
  } else {
    return bot.sendMessage(chatId, '⚠️ Send text, or a photo (with or without a caption). Type /cancel to abort.');
  }

  db.setPendingAction(chatId, { type: 'broadcast_confirm', data: { content } });
  const totalUsers = Object.keys(db.readDb().users).length;

  await bot.sendMessage(chatId, `📢 *Broadcast Preview* (will be sent to *${totalUsers}* users) - what you see below is exactly what they receive:`, { parse_mode: 'Markdown' });

  try {
    if (content.kind === 'photo') {
      await bot.sendPhoto(chatId, content.fileId, { caption: content.caption, parse_mode: 'HTML' });
    } else {
      await bot.sendMessage(chatId, content.text, { parse_mode: 'HTML' });
    }
  } catch (err) {
    db.clearPendingAction(chatId);
    return bot.sendMessage(chatId, `⚠️ The preview could not be displayed (usually because of invalid or unclosed HTML tags): ${err.message}\n\nTry /admin -> 📢 Broadcast again with corrected text.`);
  }

  await bot.sendMessage(chatId, `Send it to all *${totalUsers}* users now?`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: `✅ Yes, Send Now`, callback_data: 'admin:broadcast:send' }],
      [{ text: '❌ Cancel', callback_data: 'admin:broadcast:cancel' }]
    ] }
  });
}

// ================= ADMIN PANEL (FULL INLINE) =================

// ===== Menu utama /admin — DIKELOMPOKKAN jadi 4 kategori =====
// Sebelumnya 22 tombol admin ditumpuk jadi 1 daftar flat (20 baris) di menu
// utama - kebanyakan scroll & susah nyari tombol tertentu begitu fitur admin
// makin banyak. Sekarang menu utama cuma tampilkan 4 kategori; tiap kategori
// buka submenu-nya sendiri (lihat adminProductsKeyboard() dst di bawah).
// PENTING: callback_data tiap tombol AKSI (mis. 'admin:listproducts') TIDAK
// diubah sama sekali - cuma dipindah pengelompokannya di UI - jadi semua
// handler 'admin:xxx' yang sudah ada tetap jalan tanpa perlu diubah.
function adminMainKeyboard() {
  return {
    inline_keyboard: [
      [withStyle(withButtonIcon({ text: '📦 Produk & Stok', callback_data: 'admin:cat_products' }, 'admin_cat_products'), 'primary')],
      [withStyle(withButtonIcon({ text: '💰 User & Saldo', callback_data: 'admin:cat_users' }, 'admin_cat_users'), 'primary')],
      [withStyle(withButtonIcon({ text: '📊 Laporan & Statistik', callback_data: 'admin:cat_reports' }, 'admin_cat_reports'), 'primary')],
      [withStyle(withButtonIcon({ text: '🎁 Gift (Userbot)', callback_data: 'admin:cat_gift' }, 'admin_cat_gift'), 'primary')],
      [withStyle(withButtonIcon({ text: '⚙️ Pengaturan Toko', callback_data: 'admin:cat_settings' }, 'admin_cat_settings'), 'primary')]
    ]
  };
}

// ---- Kategori 1: Produk & Stok (11 tombol aksi, sama persis seperti sebelumnya) ----
function adminProductsKeyboard() {
  return {
    inline_keyboard: [
      [withButtonIcon({ text: '📦 Daftar Produk', callback_data: 'admin:listproducts' }, 'admin_daftar_produk')],
      [
        withButtonIcon({ text: '➕ Tambah Produk', callback_data: 'admin:addproduct' }, 'admin_tambah_produk'),
        withButtonIcon({ text: '🗑️ Hapus Produk', callback_data: 'admin:removeproduct' }, 'admin_hapus_produk')
      ],
      [withButtonIcon({ text: '➕ Tambah Varian (produk multi-varian)', callback_data: 'admin:addvariant' }, 'admin_tambah_varian')],
      [withButtonIcon({ text: '📥 Tambah Stock', callback_data: 'admin:addstock' }, 'admin_tambah_stock')],
      [withButtonIcon({ text: '🔌 Supplier API', callback_data: 'admin:supplier' }, 'admin_supplier_api')],
      [withButtonIcon({ text: '🔌 Canboso API', callback_data: 'admin:canboso' }, 'admin_supplier_api')],
      [
        withButtonIcon({ text: '💲 Set Harga', callback_data: 'admin:setprice' }, 'admin_set_harga'),
        withButtonIcon({ text: '📝 Set Deskripsi', callback_data: 'admin:setdesc' }, 'admin_set_deskripsi')
      ],
      [withButtonIcon({ text: '🎁 Set Tier Diskon Grosir', callback_data: 'admin:settierprice' }, 'admin_set_tier_diskon')],
      [
        withButtonIcon({ text: '✏️ Set How to Use', callback_data: 'admin:sethowto' }, 'admin_set_howto'),
        withButtonIcon({ text: '🖼️ Set Logo', callback_data: 'admin:setlogo' }, 'admin_set_logo')
      ],
      [withButtonIcon({ text: '😀 Ganti Emoji Produk', callback_data: 'admin:setemoji' }, 'admin_set_emoji')],
      [withButtonIcon({ text: '‹ Back', callback_data: 'admin:menu' }, 'back')]
    ]
  };
}

// ---- Kategori 2: User & Saldo ----
function adminUsersKeyboard() {
  return {
    inline_keyboard: [
      [withButtonIcon({ text: '💰 Atur Saldo User', callback_data: 'admin:addbalance' }, 'admin_atur_saldo')],
      [withButtonIcon({ text: '📋 List User', callback_data: 'admin:listusers:1' }, 'admin_list_user')],
      [withButtonIcon({ text: '‹ Back', callback_data: 'admin:menu' }, 'back')]
    ]
  };
}

// ---- Kategori 3: Laporan & Statistik ----
function adminReportsKeyboard() {
  return {
    inline_keyboard: [
      [
        withButtonIcon({ text: '📜 Log Pengiriman', callback_data: 'admin:deliverylog' }, 'admin_log_pengiriman'),
        withButtonIcon({ text: '🔍 Cek Order ID', callback_data: 'admin:checkorder' }, 'admin_cek_order')
      ],
      [withButtonIcon({ text: '📊 Statistik', callback_data: 'admin:stats' }, 'admin_statistik')],
      [withButtonIcon({ text: '‹ Back', callback_data: 'admin:menu' }, 'back')]
    ]
  };
}

// ---- Kategori 4: Pengaturan Toko ----
function adminSettingsKeyboard() {
  return {
    inline_keyboard: [
      [withButtonIcon({ text: '🛠️ Maintenance Bot', callback_data: 'admin:maintenance' }, 'admin_maintenance')],
      [withButtonIcon({ text: '🎨 Kelola Emoji ID', callback_data: 'admin:emojiids' }, 'admin_kelola_emoji')],
      [withButtonIcon({ text: '💾 Auto Backup', callback_data: 'admin:backup' }, 'admin_auto_backup')],
      [withButtonIcon({ text: '📢 Broadcast', callback_data: 'admin:broadcast' }, 'admin_broadcast')],
      [withButtonIcon({ text: '🔐 Wajib Join Channel/Grup', callback_data: 'admin:forcejoin' }, 'admin_forcejoin')],
      [withButtonIcon({ text: '📣 Set Notifikasi Channel', callback_data: 'admin:channelnotif' }, 'admin_channel_notif')],
      [withButtonIcon({ text: '‹ Back', callback_data: 'admin:menu' }, 'back')]
    ]
  };
}

// ---- Kategori 5: Gift (Userbot) ----
function adminGiftKeyboard() {
  return {
    inline_keyboard: [
      [withButtonIcon({ text: '🌟 Cek Saldo Stars', callback_data: 'admin:gift_balance' }, 'admin_gift_balance')],
      [withButtonIcon({ text: '📜 Riwayat Gift Order', callback_data: 'admin:gift_history' }, 'admin_gift_history')],
      [withButtonIcon({ text: '🎁 Kelola Emoji Gift', callback_data: 'admin:giftemoji' }, 'admin_gift_emoji')],
      [withButtonIcon({ text: '💲 Atur Harga Gift', callback_data: 'admin:giftpricing' }, 'admin_gift_pricing')],
      [withButtonIcon({ text: '‹ Back', callback_data: 'admin:menu' }, 'back')]
    ]
  };
}

// ===== Fitur "💲 Atur Harga Gift" =====
// Override live (tanpa restart) untuk GIFT_MARKUP_PCT & STARS_TO_USD_RATE
// dari .env - dipakai giftPriceUsd() di fitur Buy Gift/Confess Gift.
// Disimpan di db.settings.giftPricing (lihat db.js) - null berarti
// masih pakai default .env, jadi kalau admin belum pernah sentuh menu ini
// harga tetap sama persis kayak sebelumnya.
function adminGiftPricingText() {
  const pricing = db.getGiftPricingSettings();
  const effectiveMarkup = pricing.markupPct != null ? pricing.markupPct : GIFT_MARKUP_PCT;
  const effectiveRate = pricing.starsToUsdRate != null ? pricing.starsToUsdRate : STARS_TO_USD_RATE;
  const sampleStars = 50;
  const samplePrice = usd((sampleStars * effectiveRate) * (1 + effectiveMarkup / 100));
  return (
    `💲 <b>Atur Harga Gift</b>\n\n` +
    `Berlaku untuk 🎁 Buy Gift/Confess Gift.\n\n` +
    `📈 Markup: <b>${effectiveMarkup}%</b>${pricing.markupPct == null ? ' <i>(default .env)</i>' : ' <i>(custom)</i>'}\n` +
    `💱 Kurs Stars→USD: <b>${effectiveRate}</b>${pricing.starsToUsdRate == null ? ' <i>(default .env)</i>' : ' <i>(custom)</i>'}\n\n` +
    `Contoh: gift ${sampleStars}⭐ → harga jual ≈ <b>${samplePrice}</b>\n\n` +
    `Pilih yang mau diubah:`
  );
}

function adminGiftPricingKeyboard() {
  const pricing = db.getGiftPricingSettings();
  return {
    inline_keyboard: [
      [{ text: '📈 Ubah Markup %', callback_data: 'admin:giftpricingmarkup' }],
      [{ text: '💱 Ubah Kurs Stars→USD', callback_data: 'admin:giftpricingrate' }],
      ...(pricing.markupPct != null || pricing.starsToUsdRate != null
        ? [[withStyle({ text: '↩️ Reset ke Default .env', callback_data: 'admin:giftpricingreset' }, 'danger')]]
        : []),
      [withButtonIcon({ text: '‹ Back', callback_data: 'admin:cat_gift' }, 'back')],
      [withButtonIcon({ text: '🏠 Main Menu', callback_data: 'admin:menu' }, 'admin_menu_utama')]
    ]
  };
}

// Beda dari "🎨 Kelola Emoji ID" biasa (yang daftar key-nya STATIS di
// EMOJI_CATEGORIES) - daftar di sini DINAMIS, diambil live dari katalog gift
// Telegram (userbot.getGiftCatalog()), soalnya katalog gift bisa berubah
// (item limited baru muncul / sold out). Tetap PAKAI ALUR CAPTURE yang SAMA
// (pending.type 'set_emoji_id', lihat handler-nya) - cuma scope-nya "gift"
// dan key-nya giftId (bukan stars), supaya 2 gift beda yang harganya
// kebetulan sama tetap bisa dikasih ikon beda-beda.
function isGiftEmojiFilled(giftId) {
  return !!db.getEmojiId(`gift:${giftId}`);
}

async function adminGiftEmojiListKeyboard() {
  const rows = [];
  try {
    const catalog = await userbot.getGiftCatalog();
    catalog.slice(0, 30).forEach(g => {
      const filled = isGiftEmojiFilled(g.id) ? '✅' : '⚪';
      rows.push([{ text: `${filled} 🎁 ${g.stars}⭐ (id: ${g.id})`, callback_data: `admin:emojiset:gift:${g.id}` }]);
    });
  } catch (err) {
    logError('adminGiftEmojiListKeyboard', err);
  }
  rows.push([withButtonIcon({ text: '‹ Back', callback_data: 'admin:cat_gift' }, 'back')]);
  rows.push([withButtonIcon({ text: '🏠 Main Menu', callback_data: 'admin:menu' }, 'admin_menu_utama')]);
  return { inline_keyboard: rows };
}

function adminGiftEmojiListText() {
  return (
    `🎁 <b>Kelola Emoji Gift</b>\n\n` +
    `Daftar gift Telegram Stars yang lagi aktif di katalog (🎁 Buy Gift / 💌 Confess Gift). Tap salah satu buat pasang/ganti ikon custom emoji-nya.\n\n` +
    `✅ = sudah ada ID custom (override manual)\n` +
    `⚪ = masih pakai ikon dari Telegram (kalau ada) / fallback default\n\n` +
    `<i>Catatan: kalau katalog gift Telegram berubah (item baru muncul / limited habis), daftar di bawah ikut berubah otomatis - gift lama yang sudah di-set ikonnya tidak hilang dari database, cuma tidak muncul lagi di daftar ini kalau sudah tidak dijual.</i>`
  );
}

// ===== Data buat fitur "🎨 Kelola Emoji ID" (tangkap custom_emoji_id otomatis) =====
// Dikelompokkan sama persis dengan komentar section di emoji-id-menu-inline.js,
// supaya gampang dicocokkan kalau admin lebih suka edit manual di file itu.
const EMOJI_CATEGORIES = [
  { id: 'main', label: '🎯 Menu Utama', keys: ['buy_produk', 'profile', 'saldo_saya', 'topup', 'riwayat_pembelian', 'how_to_use', 'referral', 'support'] },
  { id: 'nav', label: '🧭 Navigasi Umum', keys: ['back', 'go_back'] },
  { id: 'desc', label: '📄 Halaman Deskripsi Produk', keys: ['how_to_use', 'buy_now'] },
  { id: 'qty', label: '🛒 Jumlah & Konfirmasi', keys: ['jumlah_custom', 'place_order', 'cancel_order'] },
  { id: 'wallet', label: '💳 Menu Wallet / Topup', keys: [
    'topup_qris', 'topup_usdt', 'topup_ton', 'topup_binance', 'batal',
    'nominal_cepat', 'nominal_custom', 'batalkan_qris',
    'copy_address_usdt', 'batalkan_usdt',
    'copy_address_ton', 'batalkan_ton',
    'copy_id_binance', 'batalkan_binance'
  ] },
  { id: 'admin', label: '🔧 Admin Panel', keys: [
    // 4 tombol kategori di menu utama /admin (lihat adminMainKeyboard())
    'admin_cat_products', 'admin_cat_users', 'admin_cat_reports', 'admin_cat_gift', 'admin_cat_settings',
    // Tombol shortcut "🏠 Menu Utama" di semua submenu/halaman admin
    'admin_menu_utama',
    'admin_daftar_produk', 'admin_tambah_produk', 'admin_hapus_produk', 'admin_tambah_stock', 'admin_supplier_api',
    'admin_tambah_varian', 'admin_set_harga', 'admin_set_howto', 'admin_set_deskripsi', 'admin_set_logo', 'admin_set_emoji', 'admin_atur_saldo', 'admin_topup_pending',
    'admin_log_pengiriman', 'admin_cek_order', 'admin_statistik', 'admin_list_user', 'admin_maintenance', 'admin_kelola_emoji', 'admin_auto_backup', 'admin_broadcast', 'admin_forcejoin', 'admin_channel_notif',
    'admin_gift_balance', 'admin_gift_history', 'admin_gift_emoji', 'admin_gift_pricing'
  ] },
  { id: 'referral_btn', label: '🎁 Tombol Halaman Refer & Earn', keys: ['share_referral', 'copy_referral'] },
  { id: 'forcejoin_btn', label: '🔐 Tombol Wajib Join Channel/Grup', keys: ['join_channel', 'checkjoin'] },
  { id: 'misc_buttons', label: '🔘 Tombol Halaman Lainnya', keys: [
    'contact_support', 'close_menu', 'recover', 'cancel_recover', 'refresh_2fa'
  ] },
  { id: 'gift_btn', label: '🎁 Tombol Pilihan Gift (Buy Gift/Confess Gift)', keys: ['gift'] }
];
const EMOJI_KEY_LABELS = {
  buy_produk: 'Buy Produk', profile: 'Profile', saldo_saya: 'Saldo Saya', topup: 'Wallet / Topup',
  riwayat_pembelian: 'My Orders', referral: 'Refer & Earn', support: 'Support',
  back: 'Tombol Kembali', go_back: 'Tombol Go Back',
  how_to_use: 'How to Use', buy_now: 'Buy Now',
  jumlah_custom: 'Jumlah Custom', place_order: 'Place Order', cancel_order: 'Cancel Order',
  topup_qris: 'Tombol QRIS (Otomatis)', topup_usdt: 'Tombol USDT - BEP20 (Otomatis)', topup_ton: 'Tombol TON / Gram (Otomatis)', topup_binance: 'Tombol Binance Pay (Otomatis)',
  batal: 'Tombol "⬅️ Batal" (nav singkat)',
  nominal_cepat: 'Tombol Nominal Cepat QRIS ($1/$5/dst)', nominal_custom: 'Tombol Nominal Kustom QRIS',
  batalkan_qris: 'Tombol Batalkan Pembayaran QRIS',
  copy_address_usdt: 'Tombol Copy Address USDT', batalkan_usdt: 'Tombol Batalkan Topup USDT',
  copy_address_ton: 'Tombol Copy Address TON', batalkan_ton: 'Tombol Batalkan Topup TON',
  copy_id_binance: 'Tombol Copy Binance ID', batalkan_binance: 'Tombol Batalkan Topup Binance Pay',
  admin_cat_products: 'Kategori: Produk & Stok', admin_cat_users: 'Kategori: User & Saldo',
  admin_cat_reports: 'Kategori: Laporan & Statistik', admin_cat_gift: 'Kategori: Gift (Userbot)', admin_cat_settings: 'Kategori: Pengaturan Toko',
  admin_menu_utama: 'Tombol Shortcut "🏠 Menu Utama" (semua submenu admin)',
  admin_daftar_produk: 'Daftar Produk', admin_tambah_produk: 'Tambah Produk', admin_hapus_produk: 'Hapus Produk',
  admin_tambah_stock: 'Tambah Stock', admin_supplier_api: 'Supplier API', admin_tambah_varian: 'Tambah Varian', admin_set_harga: 'Set Harga Produk', admin_set_howto: 'Set How to Use',
  admin_set_deskripsi: 'Set Deskripsi', admin_set_logo: 'Set Logo Produk', admin_set_emoji: 'Ganti Emoji Produk', admin_atur_saldo: 'Atur Saldo User', admin_topup_pending: 'Topup Pending', admin_log_pengiriman: 'Log Pengiriman',
  admin_cek_order: 'Cek Order ID', admin_statistik: 'Statistik', admin_list_user: 'List User', admin_maintenance: 'Maintenance Bot', admin_kelola_emoji: 'Kelola Emoji ID',
  admin_auto_backup: 'Auto Backup', admin_broadcast: 'Broadcast', admin_forcejoin: 'Wajib Join Channel/Grup',
  admin_channel_notif: 'Set Notifikasi Channel',
  admin_gift_balance: 'Cek Saldo Stars Userbot', admin_gift_history: 'Riwayat Gift Order', admin_gift_emoji: 'Kelola Emoji Gift', admin_gift_pricing: 'Atur Harga Gift',
  join_channel: 'Tombol "📢 Join Channel" (tiap channel wajib join)',
  checkjoin: 'Tombol "✅ Saya Sudah Join" (Wajib Join Channel/Grup)',
  share_referral: 'Bagikan Link Referral', copy_referral: 'Copy Refer Link',
  contact_support: 'Contact Support (Halaman Support)',
  close_menu: 'Tutup Menu (How to Use)', recover: 'Recover Product (My Orders)',
  cancel_recover: 'Batal (My Orders)', refresh_2fa: 'Refresh Kode 2FA (Detail Order)',
  gift: 'Ikon Fallback Tombol Pilihan Gift (dipakai kalau gift itu tidak punya sticker custom dari Telegram sendiri)'
};
const EMOJI_TEKS_SLOTS = [
  { key: 'product_desc', label: 'Bullet "{e}" di Deskripsi Produk & How-to-Use' },
  { key: 'menu_notif', label: 'Teks Menu / Notifikasi (welcome, order berhasil, dll)' }
];

// Emoji di teks pesan lainnya (BUKAN placeholder "⚡" bolt di atas), dikelompokkan
// per halaman supaya gampang dicari admin. Setiap item = 1 baris/ikon spesifik
// di 1 halaman, masing-masing punya slot ID sendiri (key-nya dipakai sebagai
// argumen ke-1 teksEmoji() di kode).
const TEKS_GROUPS = [
  { id: 'bolt', label: '⚡ Bolt Umum (dipakai di banyak pesan)', items: EMOJI_TEKS_SLOTS },
  { id: 'welcome', label: '👋 Pesan Welcome (/start)', items: [
    { key: 'welcome_wave', label: 'Ikon Sapaan' },
    { key: 'welcome_cart', label: 'Ikon Baris "Beli Akun Premium"' },
    { key: 'welcome_wallet', label: 'Ikon Baris "Topup Otomatis"' },
    { key: 'welcome_bolt', label: 'Ikon Baris "Auto-delivery"' },
    { key: 'welcome_gift', label: 'Ikon Baris "Refer & Earn"' },
    { key: 'welcome_arrow', label: 'Ikon Baris "Pilih Menu"' }
  ] },
  { id: 'profile', label: '👤 Halaman Profile', items: [
    { key: 'profile_title', label: 'Judul "Profile"' },
    { key: 'profile_nama', label: 'Baris Nama' },
    { key: 'profile_username', label: 'Baris Username' },
    { key: 'profile_chatid', label: 'Baris Chat ID' },
    { key: 'profile_saldo', label: 'Baris Saldo Wallet' },
    { key: 'profile_order', label: 'Baris Total Order' },
    { key: 'profile_referral', label: 'Baris Total Referral' }
  ] },
  { id: 'balance', label: '💰 Halaman Saldo Wallet', items: [
    { key: 'balance_line', label: 'Baris Saldo' }
  ] },
  { id: 'wallet', label: '💳 Halaman Wallet - Pilih Metode Topup', items: [
    { key: 'wallet_title', label: 'Ikon Judul "Wallet - Topup Saldo"' }
  ] },
  { id: 'orders', label: '🧾 Halaman My Orders', items: [
    { key: 'orders_empty', label: 'Ikon "Belum Punya Riwayat Pembelian"' }
  ] },
  { id: 'howto', label: '❗️ Halaman How to Use', items: [
    { key: 'howto_title', label: 'Ikon Judul "How it works"' }
  ] },
  { id: 'support', label: '📞 Halaman Support Center', items: [
    { key: 'support_title', label: 'Ikon Judul "Support Center"' }
  ] },
  { id: 'referral', label: '🎁 Halaman Refer & Earn', items: [
    { key: 'referral_title', label: 'Judul Halaman' },
    { key: 'referral_reward', label: 'Reward per Referral' },
    { key: 'referral_link', label: 'Link Referral Kamu' },
    { key: 'referral_howitworks', label: 'Ikon "How It Works"' },
    { key: 'referral_total', label: 'Total Referral' },
    { key: 'referral_earnings', label: 'Total Penghasilan Referral' }
  ] },
  { id: 'forcejoin', label: '🔐 Layar Wajib Join Channel/Grup', items: [
    { key: 'forcejoin_lock', label: 'Ikon Gembok (Judul)' },
    { key: 'forcejoin_sparkle', label: 'Ikon Sparkle (Pembuka Deskripsi)' },
    { key: 'forcejoin_bolt', label: 'Ikon Petir (Penutup Kalimat Pertama)' },
    { key: 'forcejoin_arrow', label: 'Ikon Panah (Instruksi Join)' },
    { key: 'forcejoin_check', label: 'Ikon Centang (dalam kutipan nama tombol)' },
    { key: 'forcejoin_status_joined', label: 'Ikon Status "Sudah Join" (per channel)' },
    { key: 'forcejoin_status_pending', label: 'Ikon Status "Belum Join" (per channel)' }
  ] },
  { id: 'success', label: '🎉 Pesan Order Berhasil', items: [
    { key: 'success_border', label: 'Ikon Border ✨ (atas & bawah judul)' },
    { key: 'success_title', label: 'Judul "ORDER BERHASIL"' },
    { key: 'success_delivered', label: 'Header Produk Sudah Terkirim' },
    { key: 'success_link', label: 'Link Aktivasi / Redeem' },
    { key: 'success_manual', label: 'Info Kirim Manual Admin' },
    { key: 'success_thanks', label: 'Ucapan Terima Kasih' }
  ] },
  { id: 'qris', label: '🧾 Tagihan QRIS (Topup)', items: [
    { key: 'qris_title', label: 'Judul "TAGIHAN QRIS SUDAH SIAP"' },
    { key: 'qris_rocket', label: 'Ikon Roket (ajakan saldo penuh)' },
    { key: 'qris_orderid', label: 'Baris Order ID' },
    { key: 'qris_saldo', label: 'Baris Saldo yang Didapat' },
    { key: 'qris_total', label: 'Baris Total Bayar via QRIS' },
    { key: 'qris_expire', label: 'Baris Berlaku Selama' },
    { key: 'qris_carabayar', label: 'Judul "Cara Bayar"' },
    { key: 'qris_step1', label: 'Langkah 1 (buka e-wallet)' },
    { key: 'qris_step2', label: 'Langkah 2 (pilih Scan QR)' },
    { key: 'qris_step3', label: 'Langkah 3 (scan & bayar)' },
    { key: 'qris_auto', label: 'Ikon Saldo Masuk Otomatis' },
    { key: 'qris_tip', label: 'Ikon Tip Batalkan Pembayaran' },
    { key: 'qris_creating', label: 'Ikon Loading "Sedang Membuat QRIS"' },
    { key: 'qris_choose_amount_title', label: 'Ikon Judul "Pilih Nominal Deposit"' }
  ] },
  { id: 'usdt', label: '🪙 Deposit USDT (BEP20)', items: [
    { key: 'usdt_title', label: 'Judul "Deposit via USDT"' },
    { key: 'usdt_min', label: 'Baris Min Deposit' },
    { key: 'usdt_max', label: 'Baris Max Deposit' },
    { key: 'usdt_address_label', label: 'Ikon Label Address' },
    { key: 'usdt_auto', label: 'Ikon Automatic Deposit' },
    { key: 'usdt_prompt', label: 'Ikon Prompt "Ketik Nominal Topup"' }
  ] },
  { id: 'ton', label: '💎 Deposit TON', items: [
    { key: 'ton_title', label: 'Judul "Deposit via TON"' },
    { key: 'ton_min', label: 'Baris Min Deposit' },
    { key: 'ton_max', label: 'Baris Max Deposit' },
    { key: 'ton_address_label', label: 'Ikon Label Address' },
    { key: 'ton_auto', label: 'Ikon Automatic Deposit' },
    { key: 'ton_prompt', label: 'Ikon Prompt "Ketik Nominal Topup"' }
  ] },
  { id: 'qty', label: '🛒 Halaman Jumlah Beli', items: [
    { key: 'qty_warning', label: 'Ikon Peringatan "Masukkan Jumlah"' },
    { key: 'qty_stock', label: 'Ikon "Stok Tersedia"' },
    { key: 'bulk_title', label: 'Ikon Judul "Diskon Grosir" (🎉)' },
    { key: 'bulk_check', label: 'Ikon Centang Tiap Baris Diskon (✅)' }
  ] },
  { id: 'confirm', label: '✅ Order Confirmation & Saldo Kurang', items: [
    { key: 'order_confirm_title', label: 'Ikon Judul "Order Confirmation"' },
    { key: 'order_confirm_balance', label: 'Baris Saldo Wallet' },
    { key: 'order_confirm_stock', label: 'Baris Stok Tersedia' },
    { key: 'insufficient_balance_warn', label: 'Ikon Peringatan "Saldo Tidak Cukup"' },
    { key: 'insufficient_balance_shortfall', label: 'Baris Nominal Kekurangan' }
  ] },
  { id: 'channelnotif', label: '📢 Notifikasi Channel (New Purchase / Top-Up)', items: [
    { key: 'channelnotif_border', label: 'Ikon Border ✨ (atas & bawah judul)' },
    { key: 'channelnotif_purchase_title', label: 'Judul "NEW PURCHASE!"' },
    { key: 'channelnotif_id', label: 'Baris ID (tersamar)' },
    { key: 'channelnotif_product', label: 'Baris Product' },
    { key: 'channelnotif_qty', label: 'Baris Quantity' },
    { key: 'channelnotif_total', label: 'Baris Total' },
    { key: 'channelnotif_time', label: 'Baris Time' },
    { key: 'channelnotif_topup_title', label: 'Judul "NEW WALLET TOP-UP!"' },
    { key: 'channelnotif_network', label: 'Baris Network' },
    { key: 'channelnotif_amount', label: 'Baris Amount' },
    { key: 'channelnotif_referral_title', label: 'Judul "NEW REFERRAL SUCCESS!"' },
    { key: 'channelnotif_referral_user', label: 'Baris User (tersamar)' },
    { key: 'channelnotif_referral_referredby', label: 'Baris Referred By (tersamar)' },
    { key: 'channelnotif_referral_reward', label: 'Baris Reward' },
    { key: 'channelnotif_footer', label: 'Ikon Footer 🔥 (baris "Fast & Trusted")' },
    { key: 'channelnotif_maintenance_start_title', label: 'Judul "MAINTENANCE DIMULAI!"' },
    { key: 'channelnotif_maintenance_start_status', label: 'Ikon Status (Maintenance Dimulai)' },
    { key: 'channelnotif_maintenance_finish_title', label: 'Judul "MAINTENANCE SELESAI!"' },
    { key: 'channelnotif_maintenance_finish_status', label: 'Ikon Status (Maintenance Selesai)' }
  ] },
  { id: 'stockalert', label: '🔔 Notifikasi Live Stock (ke Semua User)', items: [
    { key: 'stockalert_bell', label: 'Ikon Lonceng (Judul)' },
    { key: 'stockalert_product', label: 'Baris Produk' },
    { key: 'stockalert_added', label: 'Baris Jumlah Ditambahkan' },
    { key: 'stockalert_total', label: 'Baris Total Stok Sekarang' },
    { key: 'stockalert_price', label: 'Baris Harga' },
    { key: 'stockalert_footer', label: 'Ikon Footer (Ajakan Buy Now)' }
  ] },
  { id: 'maintenance', label: '🛠️ Mode Maintenance', items: [
    { key: 'maintenance_wrench', label: 'Ikon Kunci Inggris (Judul, kiri-kanan)' },
    { key: 'maintenance_sparkle', label: 'Ikon Sparkle (Pembuka Kalimat)' },
    { key: 'maintenance_bolt', label: 'Ikon Petir (Penutup Kalimat Pertama)' },
    { key: 'maintenance_clock', label: 'Ikon Jam (Baris Mohon Bersabar)' },
    { key: 'maintenance_heart', label: 'Ikon Hati (Baris Ucapan Terima Kasih)' },
    { key: 'maintenance_finished_rocket', label: '🚀 [Broadcast Selesai] Ikon Roket (Judul, kiri-kanan)' },
    { key: 'maintenance_finished_sparkle', label: '🚀 [Broadcast Selesai] Ikon Sparkle (Pembuka Kalimat)' },
    { key: 'maintenance_finished_check', label: '🚀 [Broadcast Selesai] Ikon Centang (Kata "SELESAI")' },
    { key: 'maintenance_finished_bolt', label: '🚀 [Broadcast Selesai] Ikon Petir (Penutup Kalimat Pertama)' },
    { key: 'maintenance_finished_gift', label: '🚀 [Broadcast Selesai] Ikon Gift (Baris Ajakan Order)' },
    { key: 'maintenance_finished_heart', label: '🚀 [Broadcast Selesai] Ikon Hati (Baris Ucapan Terima Kasih)' }
  ] }
];
function findTeksItemLabel(key) {
  for (const g of TEKS_GROUPS) {
    const item = g.items.find(i => i.key === key);
    if (item) return item.label;
  }
  return key;
}

function adminEmojiCategoryKeyboard() {
  const rows = EMOJI_CATEGORIES.map(cat => ([{ text: cat.label, callback_data: `admin:emojicat:${cat.id}` }]));
  rows.push([{ text: '✍️ Emoji di Teks Pesan', callback_data: 'admin:emojiteks' }]);
  rows.push([withButtonIcon({ text: '‹ Back', callback_data: 'admin:cat_settings' }, 'back')]);
  rows.push([withButtonIcon({ text: '🏠 Main Menu', callback_data: 'admin:menu' }, 'admin_menu_utama')]);
  return { inline_keyboard: rows };
}

function adminEmojiTeksGroupKeyboard() {
  const rows = TEKS_GROUPS.map(g => ([{ text: g.label, callback_data: `admin:emojiteksgroup:${g.id}` }]));
  rows.push([withButtonIcon({ text: '‹ Back', callback_data: 'admin:emojiids' }, 'back')]);
  rows.push([withButtonIcon({ text: '🏠 Main Menu', callback_data: 'admin:menu' }, 'admin_menu_utama')]);
  return { inline_keyboard: rows };
}

// Cek apakah 1 key emoji "terisi" - baik lewat hasil tangkap otomatis di
// database (prioritas 1, lihat teksEmoji()/iconFor()) MAUPUN lewat default
// yang sudah ditempel langsung di kode (EMOJI_ID_TEKS_BACKUP / EMOJI_IDS).
// Tanpa cek kode ini, checklist admin bisa nampilin ⚪ (belum diisi) padahal
// emoji-nya SUDAH tampil premium di pesan asli - bikin admin salah sangka
// kirain belum ke-set padahal sebenarnya sudah aktif dari kode.
function isTeksEmojiFilled(key) {
  return !!(db.getEmojiId(`teks:${key}`) || EMOJI_ID_TEKS_BACKUP[key]);
}
function isMenuEmojiFilled(key) {
  return !!(db.getEmojiId(`menu:${key}`) || EMOJI_IDS[key]);
}

function adminEmojiTeksItemKeyboard(groupId) {
  const group = TEKS_GROUPS.find(g => g.id === groupId);
  const rows = (group ? group.items : []).map(item => {
    const filled = isTeksEmojiFilled(item.key) ? '✅' : '⚪';
    return [{ text: `${filled} ${item.label}`, callback_data: `admin:emojiset:teks:${item.key}` }];
  });
  rows.push([withButtonIcon({ text: '‹ Back', callback_data: 'admin:emojiteks' }, 'back')]);
  rows.push([withButtonIcon({ text: '🏠 Main Menu', callback_data: 'admin:menu' }, 'admin_menu_utama')]);
  return { inline_keyboard: rows };
}

function adminEmojiKeyListKeyboard(catId) {
  const rows = [];
  const cat = EMOJI_CATEGORIES.find(c => c.id === catId);
  (cat ? cat.keys : []).forEach(key => {
    const filled = isMenuEmojiFilled(key) ? '✅' : '⚪';
    rows.push([{ text: `${filled} ${EMOJI_KEY_LABELS[key] || key}`, callback_data: `admin:emojiset:menu:${key}` }]);
  });
  rows.push([withButtonIcon({ text: '‹ Back', callback_data: 'admin:emojiids' }, 'back')]);
  rows.push([withButtonIcon({ text: '🏠 Main Menu', callback_data: 'admin:menu' }, 'admin_menu_utama')]);
  return { inline_keyboard: rows };
}

function adminProductPickKeyboard(action, productsOverride) {
  const products = productsOverride || db.getAllProducts();
  const rows = products.map(p => ([
    withProductIcon({
      text: `${p.emojiId ? '' : (p.emoji ? p.emoji + ' ' : '📦 ')}${p.name}`,
      callback_data: `admin:${action}:${p.id}`
    }, p)
  ]));
  rows.push([withButtonIcon({ text: '‹ Back', callback_data: 'admin:cat_products' }, 'back')]);
  rows.push([withButtonIcon({ text: '🏠 Main Menu', callback_data: 'admin:menu' }, 'admin_menu_utama')]);
  return { inline_keyboard: rows };
}

// parentTarget: callback_data tujuan tombol "‹ Kembali" - default 'admin:menu'
// (menu utama) kalau tidak diisi. Kalau parentTarget BUKAN menu utama, ikut
// ditambahkan 1 tombol lagi "🏠 Menu Utama" di bawahnya supaya admin tetap
// bisa lompat langsung ke menu utama tanpa harus mundur selangkah-selangkah.
function adminBackKeyboard(parentTarget) {
  const target = parentTarget || 'admin:menu';
  const rows = [[withButtonIcon({ text: '‹ Back', callback_data: target }, 'back')]];
  if (target !== 'admin:menu') {
    rows.push([withButtonIcon({ text: '🏠 Main Menu', callback_data: 'admin:menu' }, 'admin_menu_utama')]);
  }
  return { inline_keyboard: rows };
}

// ===== Data buat fitur "🔐 Wajib Join Channel/Grup" =====
// Daftar "channels" di bawah ini boleh dicampur bebas: entri channel ATAU
// entri group/supergroup, dua-duanya dicek dengan mekanisme yang SAMA persis
// (isUserMemberOfChannel() cuma pakai getChatMember, tidak peduli tipe chat-
// nya) - jadi 1 user bisa diwajibkan join beberapa channel SEKALIGUS beberapa
// group cukup dengan menambahkan semuanya lewat "➕ Tambah Channel/Grup" di
// bawah, tanpa perlu menu/kode terpisah untuk group.
function adminForceJoinText() {
  const { enabled, channels } = db.getForceJoinSettings();
  const statusLine = enabled ? '🟢 *AKTIF* - user wajib join semua channel/grup di bawah sebelum bisa pakai bot.' : '🔴 *NONAKTIF* - user bebas pakai bot tanpa perlu join channel/grup apapun.';
  const list = channels.length
    ? channels.map((c, i) => `${i + 1}. *${c.title}*\n   🔗 ${c.link}\n   🆔 \`${c.chatRef}\``).join('\n\n')
    : '_Belum ada channel/grup yang ditambahkan._';
  return `🔐 *Wajib Join Channel/Grup*\n\nStatus: ${statusLine}\n\n📋 *Daftar Channel/Grup:*\n${list}`;
}

function adminForceJoinKeyboard() {
  const { enabled, channels } = db.getForceJoinSettings();
  const rows = [];
  rows.push([withButtonIcon(
    { text: enabled ? '🔴 Nonaktifkan Wajib Join' : '🟢 Aktifkan Wajib Join', callback_data: 'admin:forcejoin_toggle' },
    'admin_forcejoin'
  )]);
  rows.push([withButtonIcon({ text: '➕ Tambah Channel/Grup', callback_data: 'admin:forcejoin_add' }, 'admin_tambah_produk')]);
  channels.forEach(c => {
    rows.push([{ text: `🗑️ Hapus: ${c.title}`, callback_data: `admin:forcejoin_remove:${c.id}` }]);
  });
  rows.push([withButtonIcon({ text: '‹ Back', callback_data: 'admin:cat_settings' }, 'back')]);
  rows.push([withButtonIcon({ text: '🏠 Main Menu', callback_data: 'admin:menu' }, 'admin_menu_utama')]);
  return { inline_keyboard: rows };
}

// ===== Admin: 📣 Set Notifikasi Channel (New Purchase / New Wallet Top-Up) =====
function adminChannelNotifText() {
  const { enabled, chatRef, title, notifyPurchase, notifyTopup, notifyReferral, notifyMaintenance } = db.getChannelNotifSettings();
  const statusLine = enabled
    ? '🟢 *AKTIF* - tiap ada pembelian/topup/referral sukses, bot otomatis kirim notifikasi ke channel tujuan.'
    : '🔴 *NONAKTIF* - belum ada notifikasi yang dikirim ke channel manapun.';
  const targetLine = chatRef
    ? `📢 *${title || chatRef}*\n🆔 \`${chatRef}\``
    : '_Belum diatur - klik "🆔 Set Channel Tujuan" di bawah._';
  return (
    `📣 *Set Notifikasi Channel*\n\n` +
    `Status: ${statusLine}\n\n` +
    `*Channel Tujuan:*\n${targetLine}\n\n` +
    `*Jenis notifikasi:*\n` +
    `${notifyPurchase ? '🟢' : '🔴'} 🎉 New Purchase (pembelian produk)\n` +
    `${notifyTopup ? '🟢' : '🔴'} 💳 New Wallet Top-Up (topup QRIS/USDT/TON)\n` +
    `${notifyReferral ? '🟢' : '🔴'} 🎁 New Referral Success (referral baru masuk)\n` +
    `${notifyMaintenance ? '🟢' : '🔴'} 🛠️ Maintenance Dimulai/Selesai (aktif/nonaktifkan Mode Maintenance)\n\n` +
    `_Tiap ikon di pesan notifikasi bisa diganti lewat "🎨 Kelola Emoji ID" -> "✍️ Emoji di Teks Pesan" -> "📢 Notifikasi Channel"._`
  );
}

function adminChannelNotifKeyboard() {
  const { enabled, chatRef, notifyPurchase, notifyTopup, notifyReferral, notifyMaintenance } = db.getChannelNotifSettings();
  const rows = [];
  rows.push([withButtonIcon(
    { text: enabled ? '🔴 Nonaktifkan Notifikasi' : '🟢 Aktifkan Notifikasi', callback_data: 'admin:channelnotif_toggle' },
    'admin_channel_notif'
  )]);
  rows.push([{ text: '🆔 Set Channel Tujuan', callback_data: 'admin:channelnotif_setchannel' }]);
  rows.push([
    { text: `${notifyPurchase ? '🟢' : '🔴'} New Purchase`, callback_data: 'admin:channelnotif_toggle_purchase' },
    { text: `${notifyTopup ? '🟢' : '🔴'} New Top-Up`, callback_data: 'admin:channelnotif_toggle_topup' }
  ]);
  rows.push([
    { text: `${notifyReferral ? '🟢' : '🔴'} New Referral`, callback_data: 'admin:channelnotif_toggle_referral' },
    { text: `${notifyMaintenance ? '🟢' : '🔴'} Maintenance`, callback_data: 'admin:channelnotif_toggle_maintenance' }
  ]);
  if (chatRef) {
    rows.push([
      { text: '🧪 Contoh Purchase', callback_data: 'admin:channelnotif_test' },
      { text: '🧪 Contoh Referral', callback_data: 'admin:channelnotif_test_referral' }
    ]);
  }
  rows.push([withButtonIcon({ text: '‹ Back', callback_data: 'admin:cat_settings' }, 'back')]);
  rows.push([withButtonIcon({ text: '🏠 Main Menu', callback_data: 'admin:menu' }, 'admin_menu_utama')]);
  return { inline_keyboard: rows };
}

function adminVariantPickKeyboard(product, action, backCallback) {
  // Pakai index varian (bukan v.id) di callback_data - v.id biasanya sudah
  // mengandung product.id sebagai prefix (mis. "gemini-pro-18-bulan-18"),
  // jadi kalau ditulis lagi utuh di sini callback_data gampang lewat batas
  // 64 byte Telegram dan bikin error "Bad Request: BUTTON_DATA_INVALID".
  const rows = product.variants.map((v, i) => ([
    { text: `${v.label} (stok saat ini: ${db.getTotalStock(v)})`, callback_data: `admin:${action}:${product.id}:${i}` }
  ]));
  rows.push([withButtonIcon({ text: '‹ Back', callback_data: backCallback || 'admin:addstock' }, 'back')]);
  rows.push([withButtonIcon({ text: '🏠 Main Menu', callback_data: 'admin:menu' }, 'admin_menu_utama')]);
  return { inline_keyboard: rows };
}

// Sama seperti adminVariantPickKeyboard() di atas, tapi HANYA tampilkan
// varian yang sudah terhubung Supplier API (v.supplierServiceId terisi) -
// dipakai oleh alur standalone "📊 Atur Markup 3-Tier" (lihat handler
// 'suppliertiermarkuppick_pick') supaya admin tidak salah pilih varian
// manual yang tidak punya modal Supplier untuk dihitung tier-nya. Index
// callback_data tetap index ASLI ke product.variants (bukan index dalam
// daftar yang sudah difilter), supaya handler tujuan tinggal langsung pakai
// product.variants[i] tanpa perlu mapping ulang.
function adminSupplierVariantPickKeyboard(product, action, backCallback) {
  const rows = [];
  product.variants.forEach((v, i) => {
    if (!v.supplierServiceId) return;
    const costLabel = typeof v.supplierCost === 'number' ? usd(v.supplierCost) : '?';
    rows.push([{ text: `${v.label} (modal: ${costLabel})`, callback_data: `admin:${action}:${product.id}:${i}` }]);
  });
  rows.push([withButtonIcon({ text: '‹ Back', callback_data: backCallback || 'admin:supplier' }, 'back')]);
  rows.push([withButtonIcon({ text: '🏠 Main Menu', callback_data: 'admin:menu' }, 'admin_menu_utama')]);
  return { inline_keyboard: rows };
}

// ===== Helper untuk fitur "Supplier API" =====

function supplierBackKeyboard() {
  return {
    inline_keyboard: [
      [withButtonIcon({ text: '‹ Back', callback_data: 'admin:supplier' }, 'back')],
      [withButtonIcon({ text: '🏠 Main Menu', callback_data: 'admin:menu' }, 'admin_menu_utama')]
    ]
  };
}

// Tampilan utama "Supplier API": status koneksi (saldo toko di AIVerse
// Hub, kalau API key sudah diisi) + daftar varian yang sedang terhubung.
async function supplierMenuText() {
  let statusLine;
  if (!AIVERSEHUB_API_KEY) {
    statusLine = '⚠️ *AIVERSEHUB_API_KEY* belum diisi di `.env` - fitur ini belum bisa dipakai.';
  } else {
    try {
      const me = await supplier.getMe();
      statusLine = `🟢 Terhubung - saldo toko di Supplier: *${usd(me.wallet_balance)}*`;
    } catch (err) {
      statusLine = `🔴 Gagal cek koneksi ke Supplier: _${err.message}_`;
    }
  }

  const linked = db.getSupplierLinkedVariants();
  const list = linked.length
    ? linked.map(l => {
        const label = `${l.productName}${l.variant.label ? ' - ' + l.variant.label : ''}`;
        const sell = db.getBasePrice(l.variant);
        const cost = l.variant.supplierCost;
        const marginTag = (typeof cost === 'number')
          ? (sell <= cost ? ' ⚠️ RUGI/IMPAS' : ` (untung ${usd(sell - cost)}/pcs)`)
          : '';
        return `• *${label}* → \`${l.variant.supplierServiceId}\`\n   Modal: ${typeof cost === 'number' ? usd(cost) : '?'} • Jual: ${usd(sell)}${marginTag}`;
      }).join('\n')
    : '_Belum ada varian yang terhubung._';

  return (
    `*Supplier API*\n\n` +
    `${statusLine}\n\n` +
    `Varian produk yang dihubungkan ke sini akan dipesan & dipenuhi OTOMATIS lewat Supplier setiap ada buyer beli (bukan dari stok lokal lagi).\n\n` +
    `🔄 Auto-sync modal & stok: ${(AIVERSEHUB_API_KEY && SUPPLIER_SYNC_INTERVAL_MINUTES > 0) ? `*aktif*, tiap *${SUPPLIER_SYNC_INTERVAL_MINUTES} menit*` : '*mati* (ubah `SUPPLIER_SYNC_INTERVAL_MINUTES` di .env untuk mengaktifkan, atau refresh manual di bawah)'}\n\n` +
    `📋 *Varian Terhubung:*\n${list}`
  );
}

function supplierMenuKeyboard() {
  const linked = db.getSupplierLinkedVariants();
  const rows = [];
  rows.push([{ text: '➕ Hubungkan Produk', callback_data: 'admin:supplierlink' }]);
  if (linked.length) {
    rows.push([{ text: '📊 Atur Markup 3-Tier', callback_data: 'admin:suppliertiermarkuppick' }]);
  }
  rows.push([
    { text: '🧾 Riwayat Order', callback_data: 'admin:supplierorders:1' },
    { text: '📊 Statistik', callback_data: 'admin:supplierstats' }
  ]);
  rows.push([{ text: '🔍 Cek Order ID (API)', callback_data: 'admin:supplierorderid' }]);
  if (linked.length) {
    rows.push([{ text: '🔄 Refresh Modal & Stok', callback_data: 'admin:supplierrefresh' }]);
  }
  // PENTING: callback_data di sini pakai INDEX ke `linked` (bukan
  // productId+variantId ditulis utuh) - gabungan keduanya gampang lewat
  // batas 64 byte Telegram (sama seperti bug BUTTON_DATA_INVALID yang
  // sudah diperbaiki di tempat lain). Index dihitung ulang dari
  // db.getSupplierLinkedVariants() tiap handler dipanggil, jadi selama
  // tidak ada perubahan link di tengah-tengah admin mengetuk tombol,
  // urutannya konsisten.
  linked.forEach((l, i) => {
    const label = `${l.productName}${l.variant.label ? ' - ' + l.variant.label : ''}`;
    rows.push([
      { text: `💲 Harga: ${label}`, callback_data: `admin:supplierharga:${i}` },
      { text: '🗑️ Putus', callback_data: `admin:supplierunlinkconfirm:${i}` }
    ]);
  });
  rows.push([withButtonIcon({ text: '‹ Back', callback_data: 'admin:cat_products' }, 'back')]);
  rows.push([withButtonIcon({ text: '🏠 Main Menu', callback_data: 'admin:menu' }, 'admin_menu_utama')]);
  return { inline_keyboard: rows };
}

// Ambil daftar service Supplier via API, lalu tampilkan sebagai keyboard
// pilihan untuk dihubungkan ke productId/variantId lokal. Daftar service
// mentah disimpan sementara di pendingAction (bukan di-encode ke
// callback_data) karena service_id/nama dari API bisa mengandung karakter
// apapun yang tidak aman dipakai langsung sebagai bagian callback_data.
async function showSupplierServicePicker(chatId, messageId, productId, variantId) {
  if (!AIVERSEHUB_API_KEY) {
    return sendOrEditAdmin(chatId, messageId, '⚠️ *AIVERSEHUB_API_KEY* belum diisi di `.env`, tidak bisa ambil daftar produk Supplier.', supplierBackKeyboard());
  }
  let services;
  try {
    services = await supplier.getProducts();
  } catch (err) {
    return sendOrEditAdmin(chatId, messageId, `⚠️ Gagal ambil daftar produk dari Supplier:\n_${err.message}_`, supplierBackKeyboard());
  }
  if (!services.length) {
    return sendOrEditAdmin(chatId, messageId, '⚠️ Supplier tidak mengembalikan produk apapun saat ini.', supplierBackKeyboard());
  }
  db.setPendingAction(chatId, { type: 'supplier_link_pick', data: { productId, variantId, services } });
  const rows = services.map((s, i) => ([{
    text: `${s.name || s.service_id} - Modal ${usd(s.price)} (stok: ${s.stock})`,
    callback_data: `admin:supplierlink_set:${i}`
  }]));
  rows.push([withButtonIcon({ text: '‹ Back', callback_data: 'admin:supplierlink' }, 'back')]);
  await sendOrEditAdmin(chatId, messageId, 'Pilih produk Supplier yang mau dihubungkan:', { inline_keyboard: rows });
}

// Teks perbandingan modal (harga API Supplier) vs harga jual lokal saat
// ini - dipakai begitu admin baru menghubungkan/mengubah harga varian.
// Kalau harga jual <= modal, tampilkan peringatan jelas (bukan cuma angka)
// supaya tidak kelewat tanpa sadar jual rugi/impas.
// Sinkron modal & stok SEMUA varian yang terhubung ke Supplier API dalam 1
// panggilan (dipakai baik oleh tombol manual "🔄 Refresh Modal & Stok" MAUPUN
// oleh auto-sync terjadwal, lihat scheduleSupplierSync() - supaya logikanya
// cuma ada di 1 tempat, tidak dobel/gampang beda perilaku). Return
// { updated, missing, lines[] } - pemanggil tinggal pilih mau ditampilkan
// Hitung ulang array tiers dari 1 angka modal + config markup% - dipakai
// baik oleh refreshSupplierData() (auto-sync berkala) MAUPUN handler
// 'supplierlink_set' (saat admin baru menghubungkan varian), supaya
// rumusnya cuma ada di 1 tempat dan konsisten di kedua alur itu.
function computeTiersFromCost(cost, markup) {
  return markup.map(m => ({
    min: m.min,
    max: m.max,
    price: Math.round(cost * (1 + (m.markupPct || 0) / 100) * 100) / 100
  }));
}

// Minta admin ketik 3 harga jual (USD) buat tier 1-49 / 50-499 / 500+ satu
// varian - dipakai oleh handler 'settierprice_pick'/'settierprice_variant'
// di atas. Kalau varian belum punya tiers sama sekali (harusnya tidak
// pernah terjadi karena addVariant/addSimpleProduct selalu isi 1 tier
// default), tampilkan harga dasar saja sebagai gambaran "harga sekarang".
function askSetTierPrice(chatId, messageId, product, variant) {
  db.setPendingAction(chatId, { type: 'set_tier_price', data: { productId: product.id, variantId: variant.id } });
  const label = variant.label && variant.label !== product.name ? `${product.name} - ${variant.label}` : product.name;
  const currentLine = (variant.tiers && variant.tiers.length > 1)
    ? `Tier saat ini: ${tierPricesSummary(variant.tiers)}`
    : `Harga saat ini: ${usd(db.getBasePrice(variant))} (belum ada tier bertingkat)`;
  // Kalau varian.priceLocked true, tier manual AMAN dari auto-sync (lihat
  // refreshSupplierData()) - beda pesan dari kondisi default (belum dikunci)
  // supaya admin tahu status kunci saat ini tanpa perlu buka menu lain.
  const supplierNote = variant.supplierServiceId
    ? (variant.priceLocked
        ? '\n\n🔒 Harga manual varian ini DIKUNCI - auto-sync Supplier tetap update modal & stok, tapi tier harga TIDAK akan ditimpa. Tekan tombol di bawah buat buka kunci lagi.'
        : '\n\n⚠️ Varian ini terhubung Supplier API - tier manual ini akan TERTIMPA lagi begitu sync modal berikutnya jalan (otomatis atau lewat "🔄 Refresh Modal & Stok"). Tekan "🔒 Kunci Harga Manual" di bawah kalau tidak mau ketimpa, atau pakai "📊 Atur Markup 3-Tier" kalau memang mau harga selalu ikut modal.')
    : '';
  let keyboard = adminBackKeyboard('admin:cat_products');
  if (variant.supplierServiceId) {
    const variantIndex = product.variants.findIndex(v => v.id === variant.id);
    const lockButton = variant.priceLocked
      ? { text: '🔓 Buka Kunci Harga Manual', callback_data: `admin:pricelocktoggle:${product.id}:${variantIndex}` }
      : { text: '🔒 Kunci Harga Manual', callback_data: `admin:pricelocktoggle:${product.id}:${variantIndex}` };
    keyboard = {
      inline_keyboard: [
        [lockButton],
        ...adminBackKeyboard('admin:cat_products').inline_keyboard
      ]
    };
  }
  return sendOrEditAdmin(chatId, messageId,
    `🎁 *Set Tier Diskon Grosir - ${label}*\n\n${currentLine}\n\n` +
    `Ketik 3 harga USD dipisah koma buat tier *1-49 / 50-499 / 500+* (boleh desimal, TANPA tanda $).\n` +
    `Contoh: \`0.65,0.69,0.65\` artinya 1-49 pcs = $0.65, 50-499 pcs = $0.69, 500+ pcs = $0.65.\n\n` +
    `Ketik /cancel untuk batal.${supplierNote}`,
    keyboard
  );
}

// Minta admin ketik 3 angka PERSEN markup (dari modal Supplier) buat tier
// 1-49 / 50-499 / 500+ satu varian - versi "markup%" dari askSetTierPrice()
// di atas, dipakai KHUSUS varian yang terhubung Supplier API (butuh modal
// live buat dihitung). Dipanggil dari 2 alur (lihat handler 'suppliertiermarkup'
// dan 'suppliertiermarkuppick_variant' di atas) supaya tampilan & pending
// action-nya konsisten di keduanya.
function askSetTierMarkup(chatId, messageId, product, variant) {
  db.setPendingAction(chatId, { type: 'set_tier_markup', data: { productId: product.id, variantId: variant.id } });
  const label = variant.label && variant.label !== product.name ? `${product.name} - ${variant.label}` : product.name;
  const cost = variant.supplierCost;
  const currentMarkup = db.getVariantTierMarkup(variant, DEFAULT_SUPPLIER_TIER_MARKUP);
  const previewNow = typeof cost === 'number' && !isNaN(cost)
    ? tierPricesSummary(computeTiersFromCost(cost, currentMarkup))
    : '?';
  return sendOrEditAdmin(chatId, messageId,
    `📊 *Atur Markup 3-Tier - ${label}*\n\n` +
    `${typeof cost === 'number' ? `Modal Supplier saat ini: ${usd(cost)}\n` : ''}Markup dipakai sekarang: ${currentMarkup.map(m => `${m.markupPct}%`).join(' / ')}\n` +
    `Harga sekarang (kalau dihitung dari markup itu): ${previewNow}\n\n` +
    `Ketik 3 angka persen dipisah koma buat tier *1-49 / 50-499 / 500+* (boleh desimal, TANPA tanda %).\n` +
    `Contoh: \`10,7,5\` artinya tier 1-49 = modal+10%, 50-499 = modal+7%, 500+ = modal+5%.\n\n` +
    `Harga langsung dihitung ulang dari modal SAAT INI setelah kamu kirim. Ketik /cancel untuk batal.`,
    supplierBackKeyboard()
  );
}

function tierPricesSummary(tiers) {
  return tiers.map(t => {
    const range = t.max === null ? `${t.min}+` : `${t.min}-${t.max}`;
    return `${range}: ${usd(t.price)}`;
  }).join(' • ');
}

// sebagai pesan admin atau cuma dicek diam-diam (auto-sync).
async function refreshSupplierData() {
  const linked = db.getSupplierLinkedVariants();
  if (!linked.length) return { updated: 0, missing: 0, priceAlerts: [], lines: [], linkedCount: 0 };

  const services = await supplier.getProducts();
  // 1 panggilan API buat SEMUA varian sekaligus (bukan per-varian) - hemat
  // rate limit Supplier (3 req/detik) walau varian yang terhubung banyak.
  const byServiceId = new Map(services.map(s => [String(s.service_id), s]));
  let updated = 0, missing = 0, invalidPrice = 0;
  const priceAlerts = []; // dipakai scheduleSupplierSync() buat kabari admin proaktif kalau ada lonjakan modal
  const stockChanges = []; // dipakai scheduleSupplierSync() buat broadcast "🔔 Stok Diperbarui" ke semua user
  const lines = linked.map(l => {
    const label = `${l.productName}${l.variant.label ? ' - ' + l.variant.label : ''}`;
    const svc = byServiceId.get(String(l.variant.supplierServiceId));
    if (!svc) {
      missing++;
      return `⚠️ *${label}* → service \`${l.variant.supplierServiceId}\` sudah tidak ada lagi di Supplier! Cek/putuskan link ini.`;
    }
    const newCost = typeof svc.price === 'number' ? svc.price : parseFloat(svc.price);
    const oldCost = typeof l.variant.supplierCost === 'number' ? l.variant.supplierCost : null;

    // ===== SAFETY: jangan pernah proses modal <= 0 / bukan angka =====
    // Kalau API Supplier sempat balas price 0/null/rusak (bug sesaat di
    // sisi mereka), JANGAN update apapun (cost, stok, tiers) untuk varian
    // ini di siklus sync ini - daripada harga jual ikut ke-set $0 (rugi
    // total/produk kejual gratis). Modal & harga lama tetap dipakai sampai
    // sync berikutnya dapat angka yang valid.
    if (isNaN(newCost) || newCost <= 0) {
      invalidPrice++;
      priceAlerts.push(`⚠️ *${label}*: modal dari Supplier tidak valid (${svc.price}) - harga/stok LAMA tetap dipakai, dilewati siklus ini. Cek manual!`);
      return `⚠️ *${label}* → modal dari Supplier tidak valid (${svc.price}), DILEWATI - harga/stok lama tetap dipakai. Cek manual!`;
    }

    db.setVariantSupplier(l.productId, l.variant.id, l.variant.supplierServiceId, newCost);
    // Sinkron juga stok LOKAL varian ini ke stok live Supplier - dulu
    // cuma ditampilkan di teks laporan tapi tidak pernah ditulis ke
    // variant.stock, jadi menu admin & daftar produk buyer selalu nampilin
    // angka lama/manual yang basi.
    const liveStock = Number(svc.stock);
    if (!isNaN(liveStock)) {
      // ===== FITUR BARU: deteksi perubahan TOTAL stok (live+manual) buat
      // trigger broadcast "🔔 Stok Diperbarui" - dibandingkan SEBELUM
      // db.setVariantStock() menimpa liveStock, supaya oldTotal beneran
      // representasi angka SEBELUM sync ini (bukan sudah ke-update).
      const oldTotal = db.getTotalStock(l.variant);
      db.setVariantStock(l.productId, l.variant.id, liveStock);
      const newTotal = (l.variant.stock || 0) + Math.max(0, Math.round(liveStock));
      if (newTotal !== oldTotal) {
        const product = db.findProduct(l.productId);
        if (product) stockChanges.push({ product, variant: l.variant, oldTotal, newTotal });
      }
    }
    // Hitung ULANG tier harga jual (1-49 / 50-499 / 500+, dst) dari modal
    // live + markup% (lihat DEFAULT_SUPPLIER_TIER_MARKUP di config.js, atau
    // variant.tierMarkup untuk override khusus produk ini) - supaya harga
    // yang dilihat buyer otomatis ikut naik/turun sesuai modal terbaru
    // Supplier, bukan angka manual yang gampang basi/rugi kalau modal naik.
    // KECUALI kalau variant.priceLocked true ("🔒 Kunci Harga Manual" -
    // lihat askSetTierPrice()) - admin sudah set harga manual lewat "🎁 Set
    // Tier Diskon Grosir" dan tidak mau ketimpa lagi, jadi tier LAMA
    // dipertahankan; modal & stok tetap ikut update seperti biasa di atas.
    let newTiers = l.variant.tiers;
    if (!l.variant.priceLocked) {
      const markup = db.getVariantTierMarkup(l.variant, DEFAULT_SUPPLIER_TIER_MARKUP);
      newTiers = computeTiersFromCost(newCost, markup);
      db.setVariantTiers(l.productId, l.variant.id, newTiers);
      l.variant.tiers = newTiers; // biar `sell`/laporan di bawah pakai tier baru, bukan yang lama di memori
    }
    updated++;

    // ===== Deteksi lonjakan modal >20% dibanding sync sebelumnya =====
    // Cuma dibandingkan kalau oldCost ada & valid (bukan link pertama kali).
    // Dipakai scheduleSupplierSync() buat kabari admin PROAKTIF (bukan cuma
    // kelihatan kalau admin buka menu Supplier API manual), soalnya harga
    // jual buyer ikut berubah otomatis - admin perlu tahu kalau lonjakannya
    // gede supaya bisa cek apakah masih masuk akal / perlu ubah markup.
    if (oldCost !== null && oldCost > 0) {
      const changePct = ((newCost - oldCost) / oldCost) * 100;
      if (Math.abs(changePct) >= 20) {
        const arrow = changePct > 0 ? '📈 naik' : '📉 turun';
        // Kalau harganya dikunci, harga JUAL tidak ikut berubah otomatis
        // (beda dari kondisi normal) - admin tetap perlu tahu modalnya
        // melonjak supaya bisa cek manual apakah margin masih masuk akal.
        const impactNote = l.variant.priceLocked
          ? 'harga jual TIDAK berubah (dikunci) - cek margin manual!'
          : 'harga jual ikut ter-update otomatis.';
        priceAlerts.push(`⚠️ *${label}*: modal ${arrow} ${Math.abs(changePct).toFixed(0)}% (${usd(oldCost)} → ${usd(newCost)}) - ${impactNote}`);
      }
    }

    const sell = db.getBasePrice(l.variant);
    const marginTag = sell <= newCost ? ' ⚠️ RUGI/IMPAS' : ` (untung ${usd(sell - newCost)}/pcs)`;
    const lockTag = l.variant.priceLocked ? ' 🔒' : '';
    const stockNum = Number(svc.stock);
    const stockTag = !isNaN(stockNum) && stockNum <= 5 ? ` • ⚠️ stok Supplier tersisa ${stockNum}` : ` • stok Supplier: ${svc.stock}`;
    // Tampilkan SEMUA tier hasil hitung (bukan cuma 1 harga dasar) supaya
    // admin langsung lihat harga di ketiga rentang qty tanpa buka db.json.
    return `• *${label}*${lockTag}\n   Modal: ${usd(newCost)} • Jual dasar: ${usd(sell)}${marginTag}${stockTag}\n   Tiers: ${tierPricesSummary(newTiers)}`;
  });
  return { updated, missing, invalidPrice, priceAlerts, lines, linkedCount: linked.length, stockChanges };
}

let supplierSyncTimer = null;

// Auto-sync modal & stok Supplier API secara berkala TANPA admin perlu klik
// "🔄 Refresh Modal & Stok" manual - lihat SUPPLIER_SYNC_INTERVAL_MINUTES di
// config.js/.env. Kalau ada link yang rusak (service_id sudah tidak ada lagi
// di Supplier) ATAU modal Supplier melonjak/anjlok >=20% (harga jual ikut
// ke-update otomatis), semua admin dikabari; kalau normal, jalan diam-diam
// (tidak spam chat admin tiap N menit).
function scheduleSupplierSync() {
  if (supplierSyncTimer) {
    clearInterval(supplierSyncTimer);
    supplierSyncTimer = null;
  }
  if (!AIVERSEHUB_API_KEY || !SUPPLIER_SYNC_INTERVAL_MINUTES || SUPPLIER_SYNC_INTERVAL_MINUTES <= 0) return;
  supplierSyncTimer = setInterval(async () => {
    try {
      const { updated, missing, priceAlerts, lines, linkedCount, stockChanges } = await refreshSupplierData();
      if (!linkedCount) return;
      if (stockChanges && stockChanges.length) {
        broadcastStockSyncChanges(stockChanges).catch(err => console.error('broadcastStockSyncChanges (Supplier) error:', err.message));
      }
      if (priceAlerts.length > 0) {
        ADMIN_IDS.forEach(id => {
          bot.sendMessage(id,
            `📊 *Auto-sync Supplier API*: ada perubahan modal signifikan pada ${priceAlerts.length} varian.\n\n${priceAlerts.join('\n')}`,
            { parse_mode: 'Markdown' }
          ).catch(() => {});
        });
      }
      if (missing > 0) {
        const brokenLines = lines.filter(l => l.startsWith('⚠️') && l.includes('sudah tidak ada lagi di Supplier'));
        ADMIN_IDS.forEach(id => {
          bot.sendMessage(id,
            `⚠️ *Auto-sync Supplier API*: ${missing} varian bermasalah saat sinkron otomatis (${updated} lainnya berhasil diperbarui).\n\n${brokenLines.join('\n')}`,
            { parse_mode: 'Markdown' }
          ).catch(() => {});
        });
      }
    } catch (err) {
      console.error('Auto-sync Supplier API gagal:', err.message);
    }
  }, SUPPLIER_SYNC_INTERVAL_MINUTES * 60 * 1000);
}

const PRODUCT_LIST_REPAINT_INTERVAL_MS = 30 * 1000; // sapu ulang tiap 30 detik
let productListRepaintTimer = null;

// ===== Live-repaint warna tombol daftar produk (🟢/🔴 style) =====
// productListKeyboard() sudah menghitung warna tombol (hijau/merah) SEGAR
// tiap kali dipanggil - tapi itu cuma kepakai begitu buyer BARU buka menu
// "🛒 Buy Product". Kalau buyer sudah punya menu itu KEBUKA di layarnya dari
// beberapa menit lalu, lalu stok berubah (auto-sync Supplier/Canboso, admin
// tambah stock, atau buyer LAIN menghabiskan stok lewat pembelian), tombol
// yang sudah kebuka itu TIDAK ikut berubah warna sendiri - Telegram tidak
// mendorong update apapun ke pesan yang sudah terkirim tanpa bot secara
// eksplisit memanggil editMessageReplyMarkup lagi.
//
// Fungsi ini menyapu SEMUA pesan yang sedang ter-track (lihat
// openProductListMsg di atas) tiap PRODUCT_LIST_REPAINT_INTERVAL_MS, dan
// panggil editMessageReplyMarkup dengan keyboard yang baru dihitung ulang.
// - Kalau isinya ternyata SAMA PERSIS (tidak ada stok yang berubah),
//   Telegram balas error "message is not modified" - ini NORMAL & di-skip
//   diam-diam (bukan tanda ada yang salah).
// - Kalau gagal karena alasan LAIN (pesan sudah dihapus user, bot diblokir,
//   chat tidak ditemukan, dst), entry itu dibuang dari tracking supaya
//   tidak terus dicoba ulang tiap 30 detik selamanya.
// - Jeda kecil antar user (sama seperti broadcast) supaya tidak memicu
//   rate limit Telegram kalau jumlah user yang lagi buka menu ini banyak.
function scheduleProductListRepaint() {
  if (productListRepaintTimer) {
    clearInterval(productListRepaintTimer);
    productListRepaintTimer = null;
  }
  productListRepaintTimer = setInterval(async () => {
    for (const [uid, msgId] of Array.from(openProductListMsg.entries())) {
      try {
        await bot.editMessageReplyMarkup(await productListKeyboard(uid), { chat_id: uid, message_id: msgId });
      } catch (err) {
        const msg = String(err.message || '');
        if (!/message is not modified/i.test(msg)) {
          openProductListMsg.delete(uid);
        }
      }
      await new Promise(r => setTimeout(r, 40));
    }
    // ===== PATCH v4: repaint juga halaman DETAIL (tombol "Buy Now") yang
    // lagi ter-track - live-check Canboso dulu kalau varian itu terhubung
    // (sama pola seperti handler 'desc:'), baru bangun ulang descKeyboard()
    // dan timpa reply_markup-nya. Kalau produk/varian sudah dihapus admin
    // di antara waktu itu, entry-nya dibuang diam-diam dari tracking.
    for (const [uid, entry] of Array.from(openProductDescMsg.entries())) {
      const { messageId, productId, variantId } = entry;
      const product = db.findProduct(productId);
      const variant = product && db.findVariant(productId, variantId);
      if (!product || !variant) {
        openProductDescMsg.delete(uid);
        continue;
      }
      if (variant.canbosoProductId) {
        try {
          const live = await canboso.getLiveStock(variant.canbosoProductId);
          if (live && !isNaN(live.stock)) {
            db.setVariantStock(productId, variantId, live.stock);
            variant.liveStock = live.stock;
          }
        } catch (err) {
          console.error(`Canboso getLiveStock (repaint desc) gagal (product_id=${variant.canbosoProductId}):`, err.message);
        }
      }
      try {
        await bot.editMessageReplyMarkup(descKeyboard(productId, variantId, uid, product, variant), { chat_id: uid, message_id: messageId });
      } catch (err) {
        const msg = String(err.message || '');
        if (!/message is not modified/i.test(msg)) {
          openProductDescMsg.delete(uid);
        }
      }
      await new Promise(r => setTimeout(r, 40));
    }
  }, PRODUCT_LIST_REPAINT_INTERVAL_MS);
}

function marginText(cost, sellPrice) {
  if (typeof cost !== 'number' || isNaN(cost)) {
    return `💰 Harga jual saat ini: ${usd(sellPrice)} (harga modal Supplier tidak diketahui)`;
  }
  if (sellPrice <= cost) {
    const rel = sellPrice === cost ? 'SAMA DENGAN' : 'LEBIH RENDAH DARI';
    return (
      `⚠️ *Peringatan margin:* harga jual saat ini (${usd(sellPrice)}) ${rel} harga modal Supplier (${usd(cost)}).\n` +
      `Kalau dibiarkan, tiap produk ini laku kamu ${sellPrice === cost ? 'impas (tidak untung sama sekali)' : 'RUGI'}. Segera naikkan harga jual di bawah.`
    );
  }
  const profit = sellPrice - cost;
  const marginPct = (profit / cost) * 100;
  return `💰 Modal: ${usd(cost)} • Jual: ${usd(sellPrice)} • Untung: *${usd(profit)}/pcs* (+${marginPct.toFixed(0)}%)`;
}

// Keyboard cepat buat atur harga jual persis setelah link/ganti modal -
// markup dihitung dari harga MODAL (bukan harga jual lama), supaya hasilnya
// konsisten walau harga jual lama sudah kadaluarsa/keliru.
// PENTING: tombolnya TIDAK bawa productId+variantId di callback_data -
// keduanya digabung gampang lewat 64 byte punya Telegram (sama seperti bug
// di successKeyboard()/adminVariantPickKeyboard()) dan bikin Telegram tolak
// kirim/edit pesan ini (BUTTON_DATA_INVALID). Konteksnya disimpan di
// pendingAction (chatId sudah unik per admin) dan dibaca lagi di handler
// 'supplierlinkmarkup'/'supplierlinkcustomprice'.
function supplierLinkPriceKeyboard(chatId, productId, variantId) {
  db.setPendingAction(chatId, { type: 'supplier_link_price_ctx', data: { productId, variantId } });
  const markups = [10, 20, 30, 50];
  return {
    inline_keyboard: [
      markups.map(pct => ({ text: `+${pct}%`, callback_data: `admin:supplierlinkmarkup:${pct}` })),
      [{ text: '✏️ Harga Custom', callback_data: 'admin:supplierlinkcustomprice' }],
      [{ text: '📊 Atur Markup 3-Tier', callback_data: 'admin:suppliertiermarkup' }],
      [withButtonIcon({ text: '‹ Selesai, Kembali', callback_data: 'admin:supplier' }, 'back')]
    ]
  };
}

// ============================================================
// ===== Helper untuk fitur "Canboso API" (supplier KEDUA) =====
// ============================================================
// Pola sama persis dengan "Supplier API" (AIVerse Hub) di atas, tapi lebih
// sederhana karena API Canboso cuma expose 2 endpoint (lihat
// supplierCanboso.js): tidak ada getMe() (saldo wallet), getOrderById(),
// getOrders(), atau getStats() - jadi menu "Riwayat Order"/"Statistik"/
// "Cek Order ID" dari Supplier API TIDAK ada versi Canboso-nya di sini.
// "🔄 Refresh Harga & Stok" tetap ada (pakai getProducts() ulang untuk
// sinkron modal & stok lokal), tapi TANPA kalkulasi 3-tier markup otomatis
// seperti Supplier API - admin atur harga jual manual lewat markup cepat/
// custom di bawah (sama seperti saat pertama link).

function canbosoBackKeyboard() {
  return {
    inline_keyboard: [
      [withButtonIcon({ text: '‹ Back', callback_data: 'admin:canboso' }, 'back')],
      [withButtonIcon({ text: '🏠 Main Menu', callback_data: 'admin:menu' }, 'admin_menu_utama')]
    ]
  };
}

function canbosoMenuText() {
  const statusLine = !CANBOSO_API_KEY
    ? '⚠️ *CANBOSO_API_KEY* belum diisi di `.env` - fitur ini belum bisa dipakai.'
    : '🟢 API key sudah diisi. (Canboso tidak expose endpoint cek saldo wallet - pastikan wallet sudah di-top-up langsung dari sisi Canboso.)';

  // Sama seperti baris "Auto-sync" di panel Supplier API (AIVerse Hub) -
  // supaya admin langsung tahu tanpa buka .env apakah auto-sync latar
  // belakang aktif & tiap berapa detik, tanpa perlu klik refresh manual.
  const effectiveSec = CANBOSO_SYNC_INTERVAL_SECONDS < 10 && CANBOSO_SYNC_INTERVAL_SECONDS > 0 ? 10 : CANBOSO_SYNC_INTERVAL_SECONDS;
  const autoSyncLine = (CANBOSO_API_KEY && CANBOSO_SYNC_INTERVAL_SECONDS > 0)
    ? `🔄 Auto-sync modal & stok: *aktif*, tiap *${effectiveSec} detik*`
    : '🔄 Auto-sync modal & stok: *mati* (ubah `CANBOSO_SYNC_INTERVAL_SECONDS` di `.env` untuk mengaktifkan, atau refresh manual di bawah)';

  const linked = db.getCanbosoLinkedVariants();
  const list = linked.length
    ? linked.map(l => {
        const label = `${l.productName}${l.variant.label ? ' - ' + l.variant.label : ''}`;
        const sell = db.getBasePrice(l.variant);
        const cost = l.variant.canbosoCost;
        const marginTag = (typeof cost === 'number')
          ? (sell <= cost ? ' ⚠️ RUGI/IMPAS' : ` (untung ${usd(sell - cost)}/pcs)`)
          : '';
        return `• *${label}* → \`${l.variant.canbosoProductId}\`\n   Modal: ${typeof cost === 'number' ? usd(cost) : '?'} • Jual: ${usd(sell)}${marginTag}`;
      }).join('\n')
    : '_Belum ada varian yang terhubung._';

  return (
    `*Canboso API*\n\n` +
    `${statusLine}\n` +
    `${autoSyncLine}\n\n` +
    `Varian produk yang dihubungkan ke sini akan dipesan & dipenuhi OTOMATIS lewat Canboso (pakai saldo wallet akun Canboso ini) setiap ada buyer beli - bukan dari stok lokal lagi.\n\n` +
    `📋 *Varian Terhubung:*\n${list}`
  );
}

function canbosoMenuKeyboard() {
  const linked = db.getCanbosoLinkedVariants();
  const rows = [];
  rows.push([{ text: '➕ Hubungkan Produk', callback_data: 'admin:canbosolink' }]);
  if (linked.length) {
    rows.push([{ text: '🔄 Refresh Harga & Stok', callback_data: 'admin:canbosorefresh' }]);
  }
  linked.forEach((l, i) => {
    const label = `${l.productName}${l.variant.label ? ' - ' + l.variant.label : ''}`;
    rows.push([
      { text: `💲 Harga: ${label}`, callback_data: `admin:canbosoharga:${i}` },
      { text: '🗑️ Putus', callback_data: `admin:canbosounlinkconfirm:${i}` }
    ]);
  });
  rows.push([withButtonIcon({ text: '‹ Back', callback_data: 'admin:cat_products' }, 'back')]);
  rows.push([withButtonIcon({ text: '🏠 Main Menu', callback_data: 'admin:menu' }, 'admin_menu_utama')]);
  return { inline_keyboard: rows };
}

// Ambil daftar produk Canboso via API, lalu tampilkan sebagai keyboard
// pilihan untuk dihubungkan ke productId/variantId lokal - pola sama
// seperti showSupplierServicePicker() di atas. Daftar produk mentah
// disimpan sementara di pendingAction (bukan di-encode ke callback_data)
// karena id/nama dari API bisa mengandung karakter apapun.
async function showCanbosoProductPicker(chatId, messageId, productId, variantId) {
  if (!CANBOSO_API_KEY) {
    return sendOrEditAdmin(chatId, messageId, '⚠️ *CANBOSO_API_KEY* belum diisi di `.env`, tidak bisa ambil daftar produk Canboso.', canbosoBackKeyboard());
  }
  let products;
  try {
    products = await canboso.getProducts();
  } catch (err) {
    return sendOrEditAdmin(chatId, messageId, `⚠️ Gagal ambil daftar produk dari Canboso:\n_${err.message}_`, canbosoBackKeyboard());
  }
  if (!products.length) {
    return sendOrEditAdmin(chatId, messageId, '⚠️ Canboso tidak mengembalikan produk apapun saat ini.', canbosoBackKeyboard());
  }
  db.setPendingAction(chatId, { type: 'canboso_link_pick', data: { productId, variantId, products } });
  const rows = products.map((p, i) => ([{
    text: `${p.name} - Modal ${isNaN(p.price) ? '❓' : usd(p.price)} (stok: ${isNaN(p.stock) ? '?' : p.stock})`,
    callback_data: `admin:canbosolink_set:${i}`
  }]));
  rows.push([{ text: '🐞 Lihat Raw Response (debug)', callback_data: 'admin:canbosodebug' }]);
  rows.push([withButtonIcon({ text: '‹ Back', callback_data: 'admin:canbosolink' }, 'back')]);
  const naNote = products.some(p => isNaN(p.price))
    ? '\n\n⚠️ Ada produk yang modalnya tampil ❓ (field harga di response API tidak dikenali). Tetap bisa dihubungkan lalu isi harga jual manual lewat ✏️ Harga Custom, atau tekan 🐞 Lihat Raw Response untuk cek nama field aslinya.'
    : '';
  await sendOrEditAdmin(chatId, messageId, `Pilih produk Canboso yang mau dihubungkan:${naNote}`, { inline_keyboard: rows });
}

// Keyboard cepat atur harga jual setelah link/refresh modal Canboso - pola
// sama seperti supplierLinkPriceKeyboard(), tanpa opsi "3-Tier" (Canboso
// tidak punya kalkulasi tier otomatis di sini, cukup markup flat).
function canbosoLinkPriceKeyboard(chatId, productId, variantId) {
  db.setPendingAction(chatId, { type: 'canboso_link_price_ctx', data: { productId, variantId } });
  const markups = [10, 20, 30, 50];
  return {
    inline_keyboard: [
      markups.map(pct => ({ text: `+${pct}%`, callback_data: `admin:canbosolinkmarkup:${pct}` })),
      [{ text: '✏️ Harga Custom', callback_data: 'admin:canbosolinkcustomprice' }],
      [withButtonIcon({ text: '‹ Selesai, Kembali', callback_data: 'admin:canboso' }, 'back')]
    ]
  };
}

// Sinkron ulang modal & stok SEMUA varian yang terhubung ke Canboso, dari
// getProducts() live - dipanggil oleh tombol "🔄 Refresh Harga & Stok".
// Beda dari refreshSupplierData() (AIVerse Hub): TIDAK menghitung ulang
// tiers otomatis dari markup% (Canboso tidak punya kalkulasi tier per-
// varian tersimpan) - cuma update variant.canbosoCost & variant.stock,
// admin yang atur ulang harga jual manual kalau modal berubah signifikan.
async function refreshCanbosoData() {
  const products = await canboso.getProducts();
  const byId = new Map(products.map(p => [String(p.id), p]));
  const linked = db.getCanbosoLinkedVariants();
  let updated = 0, missing = 0;
  const lines = [];
  const stockChanges = []; // dipakai scheduleCanbosoSync() buat broadcast "🔔 Stok Diperbarui" ke semua user
  for (const l of linked) {
    const remote = byId.get(String(l.variant.canbosoProductId));
    const label = `${l.productName}${l.variant.label ? ' - ' + l.variant.label : ''}`;
    if (!remote) {
      missing++;
      lines.push(`⚠️ *${label}* - product_id \`${l.variant.canbosoProductId}\` sudah tidak ada di Canboso.`);
      continue;
    }
    db.setVariantCanboso(l.productId, l.variant.id, l.variant.canbosoProductId, remote.price);
    if (!isNaN(remote.stock)) {
      const oldTotal = db.getTotalStock(l.variant);
      db.setVariantStock(l.productId, l.variant.id, remote.stock);
      const newTotal = (l.variant.stock || 0) + Math.max(0, Math.round(remote.stock));
      if (newTotal !== oldTotal) {
        const product = db.findProduct(l.productId);
        if (product) stockChanges.push({ product, variant: l.variant, oldTotal, newTotal });
      }
    }
    updated++;
    const stockDisplay = isNaN(remote.stock) ? '❓ (field stok belum dikenali - lihat 🐞 Raw Response)' : remote.stock;
    lines.push(`✅ *${label}* - Modal: ${isNaN(remote.price) ? '❓' : usd(remote.price)} • Stok: ${stockDisplay}`);
  }
  return { updated, missing, lines, stockChanges };
}

let canbosoSyncTimer = null;

// Auto-sync modal & stok Canboso API secara berkala TANPA admin perlu klik
// "🔄 Refresh Harga & Stok" manual - lihat CANBOSO_SYNC_INTERVAL_SECONDS di
// config.js/.env. Mirip scheduleSupplierSync() di atas, tapi pakai satuan
// DETIK (bukan menit, lihat penjelasan di config.js) dan TIDAK ada
// perhitungan ulang tier dari markup% (Canboso tidak simpan markup per-
// varian seperti Supplier API - refreshCanbosoData() cuma update modal &
// stok, harga jual tetap manual). Kalau ada link yang rusak (product_id
// sudah tidak ada lagi di Canboso) ATAU stok gagal diparse (NaN, nama
// field belum dikenali), admin dikabari; kalau normal, jalan diam-diam
// (tidak spam chat admin tiap sync).
function scheduleCanbosoSync() {
  if (canbosoSyncTimer) {
    clearInterval(canbosoSyncTimer);
    canbosoSyncTimer = null;
  }
  if (!CANBOSO_API_KEY || !CANBOSO_SYNC_INTERVAL_SECONDS || CANBOSO_SYNC_INTERVAL_SECONDS <= 0) return;
  // Pengaman rate limit: nilai 1-9 detik dianggap terlalu rapat (bisa
  // memicu 429 Too Many Requests di Canboso kalau banyak varian
  // terhubung), otomatis dinaikkan ke minimum 10 detik.
  const intervalSec = CANBOSO_SYNC_INTERVAL_SECONDS < 10 ? 10 : CANBOSO_SYNC_INTERVAL_SECONDS;
  if (intervalSec !== CANBOSO_SYNC_INTERVAL_SECONDS) {
    console.warn(`⚠️ CANBOSO_SYNC_INTERVAL_SECONDS=${CANBOSO_SYNC_INTERVAL_SECONDS} terlalu rapat, dinaikkan ke ${intervalSec} detik untuk jaga rate limit Canboso.`);
  }
  canbosoSyncTimer = setInterval(async () => {
    try {
      const linkedCheck = db.getCanbosoLinkedVariants();
      if (!linkedCheck.length) return;
      const { updated, missing, lines, stockChanges } = await refreshCanbosoData();
      if (stockChanges && stockChanges.length) {
        broadcastStockSyncChanges(stockChanges).catch(err => console.error('broadcastStockSyncChanges (Canboso) error:', err.message));
      }
      if (missing > 0) {
        const brokenLines = lines.filter(l => l.startsWith('⚠️') && l.includes('sudah tidak ada di Canboso'));
        notifyAdmins(
          `⚠️ <b>Auto-sync Canboso API</b>: ${missing} varian bermasalah saat sinkron otomatis (${updated} lainnya berhasil diperbarui).\n\n${brokenLines.map(l => escapeHtml(l)).join('\n')}`
        );
      }
      const unknownStockLines = lines.filter(l => l.includes('field stok belum dikenali'));
      if (unknownStockLines.length > 0) {
        notifyAdmins(
          `⚠️ <b>Auto-sync Canboso API</b>: stok ${unknownStockLines.length} varian masih gagal terbaca (field belum dikenali).\n\n${unknownStockLines.map(l => escapeHtml(l)).join('\n')}\n\nCek 🐞 Lihat Raw Response untuk lihat nama field aslinya.`
        );
      }
    } catch (err) {
      console.error('Auto-sync Canboso API gagal:', err.message);
    }
  }, intervalSec * 1000);
}



// biar gampang dibaca admin - fallback ke string mentah kalau parsing gagal.
function formatSupplierDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const bulan = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())} ${bulan[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const SUPPLIER_ORDERS_PAGE_SIZE = 10;

// GET /api/v1/orders - riwayat order toko kita DI SISI Supplier (beda
// dari "🧾 My Orders" buyer yang lihat riwayat beli mereka sendiri di bot
// ini). Berguna buat admin audit: order mana yang sukses/gagal di sisi
// supplier, tanpa perlu buka dashboard Supplier secara terpisah.
async function supplierOrdersText(page) {
  if (!AIVERSEHUB_API_KEY) {
    return { text: '⚠️ *AIVERSEHUB_API_KEY* belum diisi di `.env`, tidak bisa ambil riwayat order.', totalPages: 1 };
  }
  let json;
  try {
    json = await supplier.getOrders({ page, limit: SUPPLIER_ORDERS_PAGE_SIZE });
  } catch (err) {
    return { text: `⚠️ Gagal ambil riwayat order dari Supplier:\n_${err.message}_`, totalPages: 1 };
  }
  const orders = Array.isArray(json.orders) ? json.orders : [];
  if (!orders.length) {
    return { text: '🧾 *Riwayat Order Supplier*\n\n_Belum ada order sama sekali._', totalPages: 1 };
  }
  const statusIcon = s => s === 'success' ? '✅' : s === 'pending' ? '⏳' : '❌';
  const lines = orders.map(o =>
    `${statusIcon(o.status)} \`${o.order_id}\` - ${o.service} x${o.quantity}\n` +
    `   ${usd(o.amount || 0)} • ${o.status} • ${formatSupplierDate(o.created_at)}`
  ).join('\n\n');
  const totalPages = Math.max(1, Number(json.total_pages) || 1);
  return {
    text: `🧾 *Riwayat Order Supplier* (hal. ${json.page || page}/${totalPages}, total ${json.total_orders ?? orders.length} order)\n\n${lines}`,
    totalPages,
    page: json.page || page
  };
}

function supplierOrdersKeyboard(page, totalPages) {
  const navRow = [];
  if (page > 1) navRow.push({ text: '‹ Previous', callback_data: `admin:supplierorders:${page - 1}` });
  if (page < totalPages) navRow.push({ text: 'Next ›', callback_data: `admin:supplierorders:${page + 1}` });
  const rows = [];
  if (navRow.length) rows.push(navRow);
  rows.push([withButtonIcon({ text: '‹ Back', callback_data: 'admin:supplier' }, 'back')]);
  return { inline_keyboard: rows };
}

// GET /api/v1/stats - ringkasan deposit, sales, dan breakdown per produk di
// sisi Supplier. Tanpa filter start/end (pakai default periode API).
async function supplierStatsText() {
  if (!AIVERSEHUB_API_KEY) {
    return '⚠️ *AIVERSEHUB_API_KEY* belum diisi di `.env`, tidak bisa ambil statistik.';
  }
  let stats;
  try {
    stats = await supplier.getStats();
  } catch (err) {
    return `⚠️ Gagal ambil statistik dari Supplier:\n_${err.message}_`;
  }
  const d = stats.deposits || {};
  const s = stats.sales || {};
  // API bisa saja tidak mengembalikan sebagian field (mis. periode baru
  // tanpa transaksi) - fallback ke 0 supaya tidak muncul "$NaN" di teks.
  const u = n => usd(n || 0);
  const breakdown = Array.isArray(stats.products_breakdown) ? stats.products_breakdown : [];
  const breakdownText = breakdown.length
    ? breakdown
        .slice()
        .sort((a, b) => (b.revenue || 0) - (a.revenue || 0))
        .slice(0, 10)
        .map(p => `• ${p.name || p.service_id}: ${p.quantity_sold || 0} terjual - ${u(p.revenue)}`)
        .join('\n')
    : '_Belum ada penjualan._';

  return (
    `📊 *Statistik Supplier*\n\n` +
    `💰 *Deposit*\n` +
    `Hari ini: ${u(d.today)} • 7 hari: ${u(d['7d'])} • 30 hari: ${u(d['30d'])}\n` +
    `1 tahun: ${u(d['365d'])} • Sepanjang waktu: ${u(d.all_time)}\n\n` +
    `🛒 *Penjualan (Order via API)*\n` +
    `Hari ini: ${u(s.today)} • 7 hari: ${u(s['7d'])} • 30 hari: ${u(s['30d'])}\n` +
    `1 tahun: ${u(s['365d'])} • Sepanjang waktu: ${u(s.all_time)}\n\n` +
    `📦 *Produk Terlaris*\n${breakdownText}`
  );
}

// Layar pilih CARA nambah stok - 📋 Link/Kode (auto-kirim, lewat
// addStockItems) ATAU 🔢 Angka Saja (manual, lewat addManualStock, buat
// produk yang dikirim admin sendiri secara manual ke buyer). Ditampilkan
// begitu admin sudah pilih produk/varian tujuan di /admin -> 📥 Tambah Stock.
function addStockModeText(productName, variantLabel, currentStock) {
  const title = variantLabel && variantLabel !== productName ? `${productName} - ${variantLabel}` : productName;
  return (
    `📥 *Tambah Stock - ${title}*\n` +
    `📦 Total stok saat ini: *${currentStock}*\n\n` +
    `Pilih cara nambah stok:\n\n` +
    `📋 *Link/Kode (Auto-Kirim)* - tempel link/kode redeem, otomatis terkirim ke buyer begitu ada yang beli.\n` +
    `🔢 *Angka Saja (Manual)* - cuma nambah JUMLAH stok tanpa link/kode, cocok untuk produk yang kamu kirim manual sendiri ke buyer.\n\n` +
    `_Begitu stok berhasil ditambah (cara manapun), bot otomatis kirim notifikasi "🔔 Stok Baru Tersedia!" + tombol Buy Now ke SEMUA user._`
  );
}

function addStockModeKeyboard(productId, variantId) {
  const ref = productRef(productId, variantId);
  return {
    inline_keyboard: [
      [withButtonIcon({ text: '📋 Kirim Link/Kode (Auto-Kirim)', callback_data: `admin:addstockmode:${ref}:items` }, 'admin_tambah_stock')],
      [withButtonIcon({ text: '🔢 Tambah Angka Saja (Manual)', callback_data: `admin:addstockmode:${ref}:qty` }, 'admin_tambah_stock')],
      [withButtonIcon({ text: '‹ Back', callback_data: 'admin:addstock' }, 'back')],
      [withButtonIcon({ text: '🏠 Main Menu', callback_data: 'admin:menu' }, 'admin_menu_utama')]
    ]
  };
}

// Instruksi "Tambah Stock" dengan contoh 2 cara: satu-satu (1/1) & bulk.
function stockInstructionsText(productName, variantLabel, currentStock) {
  const title = variantLabel && variantLabel !== productName ? `${productName} - ${variantLabel}` : productName;
  return (
    `📥 *Tambah Stock - ${title}*\n` +
    `📦 Stok siap auto-kirim saat ini: *${currentStock}*\n\n` +
    `Kirim data stok. *1 baris = 1 unit stok*, boleh ketik satu-satu (1 baris per pesan) atau bulk (banyak baris dalam 1 pesan sekaligus) — bebas dicampur.\n\n` +
    `Setiap baris boleh salah satu dari 2 format ini, boleh dicampur bebas dalam kiriman yang sama:\n\n` +
    `*1️⃣ Link/kode saja*\n` +
    '`https://link-redeem-1...`\n\n' +
    `*2️⃣ Kombo akun (Email + Password + Kode 2FA + Link)*\n` +
    `Pisahkan tiap field pakai tanda \`|\` (pipe), urutan tetap: Email, Password, Kode 2FA, Link.\n` +
    `Untuk Kode 2FA, isi *Secret Key TOTP*-nya (bukan kode 6 digit statis) — persis seperti yang kamu masukkan ke situs [2fa.cn](https://2fa.cn) atau Google Authenticator. Boleh pakai spasi atau tidak, sama saja:\n` +
    '`akun1@mail.com|Password123|kqzj jo6v m3ob nywd ag7m b4uo foa4 mzby|https://link-login-1...`\n' +
    '`akun1b@mail.com|Password123|KQZJJO6VM3OBNYWDAG7MB4UOFOA4MZBY|https://link-login-1b...`  _(tanpa spasi, hasilnya sama)_\n' +
    `Bot otomatis HITUNG kode 6 digit yang aktif saat itu dari secret-nya (algoritma sama seperti 2fa.cn/Google Authenticator) - jadi kode yang dilihat buyer selalu live & valid, bukan basi. Kalau kamu ketik kode digit statis di sini (bukan secret), tetap ditampilkan apa adanya seperti biasa - tidak error.\n` +
    `Boleh berhenti dari belakang kalau field terakhir memang tidak ada (mis. tanpa Link):\n` +
    '`akun2@mail.com|Password456|kqzjjo6vm3obnywd`  _(cuma 3 field, Link tidak ditampilkan)_\n' +
    `Tapi kalau yang di-skip itu field di *tengah* (mis. tanpa 2FA tapi ada Link), kosongkan saja bagiannya - jangan dihapus segmennya, supaya Link tidak ketuker posisi:\n` +
    '`akun3@mail.com|Password789||https://link-login-3...`  _(2 tanda \\| berdempetan = Kode 2FA dikosongkan)_\n\n' +
    `Contoh kirim bulk campur kedua format sekaligus:\n` +
    '```\nhttps://link-redeem-1...\nakun1@mail.com|Password123|kqzjjo6vm3obnywdag7mb4uofoa4mzby|https://link-login-1...\nakun2@mail.com|Password456||https://link-login-2...\nhttps://link-redeem-2...\n```\n\n' +
    `Setiap kirim, bot balas konfirmasi jumlah yang masuk + total stok terbaru. Ketik /cancel kalau sudah selesai.`
  );
}

async function sendOrEditAdmin(chatId, messageId, text, keyboard, parseMode) {
  const mode = parseMode || 'Markdown';
  const opts = { chat_id: chatId, message_id: messageId, parse_mode: mode, reply_markup: keyboard };
  if (messageId) {
    await bot.editMessageText(text, opts).catch(() => bot.sendMessage(chatId, text, { parse_mode: mode, reply_markup: keyboard }));
  } else {
    bot.sendMessage(chatId, text, { parse_mode: mode, reply_markup: keyboard });
  }
}

// PENTING: regex WAJIB di-anchor ke awal teks (^) supaya cuma cocok kalau
// pesannya BENERAN diawali "/cancel", bukan cuma MENGANDUNG "/cancel" di
// mana saja. Tanpa "^", pesan bebas apapun yang kebetulan menyebut
// "/cancel" di tengah kalimat (mis. deskripsi produk/how-to-use yang
// isinya "...untuk batal ketik /cancel di grup support...") akan ikut
// men-trigger handler ini dan DIAM-DIAM membatalkan pending action admin
// yang lagi jalan (mis. lagi ngetik teks how-to-use panjang) - teks yang
// sudah diketik hilang tanpa peringatan jelas kenapa.
bot.onText(/^\/cancel(?:\s|$)/, (msg) => {
  db.clearPendingAction(msg.chat.id);
  bot.sendMessage(msg.chat.id, 'Dibatalkan.');
});

bot.onText(/^\/hapusemoji(?:\s|$)/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;
  const pending = db.getPendingAction(chatId);
  if (!pending || pending.type !== 'set_emoji_id') {
    return bot.sendMessage(chatId, 'Gak ada proses "Set Emoji" yang lagi aktif.');
  }
  const { scope, key } = pending.data;
  db.clearEmojiId(`${scope}:${key}`);
  db.clearPendingAction(chatId);
  bot.sendMessage(chatId, `🗑️ ID emoji untuk "${key}" dikosongkan, balik ke default.`);
});

bot.onText(/^\/admin/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;
  db.clearPendingAction(chatId);
  bot.sendMessage(chatId, '🔧 *Admin Panel*\n\nPilih kategori di bawah:', { parse_mode: 'Markdown', reply_markup: adminMainKeyboard() });
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;
  if (!data.startsWith('admin:') || !isAdmin(chatId)) return;

  try {
    const parts = data.split(':'); // admin:<action>[:<param>]
    const action = parts[1];
    const param = parts[2];

    if (action === 'menu') {
      db.clearPendingAction(chatId);
      await sendOrEditAdmin(chatId, messageId, '🔧 *Admin Panel*\n\nPilih kategori di bawah:', adminMainKeyboard());
    }

    // ---- 4 kategori menu utama /admin (lihat adminMainKeyboard()) ----
    else if (action === 'cat_products') {
      db.clearPendingAction(chatId);
      await sendOrEditAdmin(chatId, messageId, '📦 *Produk & Stok*\n\nPilih menu di bawah:', adminProductsKeyboard());
    }

    else if (action === 'cat_users') {
      db.clearPendingAction(chatId);
      await sendOrEditAdmin(chatId, messageId, '💰 *User & Saldo*\n\nPilih menu di bawah:', adminUsersKeyboard());
    }

    else if (action === 'cat_reports') {
      db.clearPendingAction(chatId);
      await sendOrEditAdmin(chatId, messageId, '📊 *Laporan & Statistik*\n\nPilih menu di bawah:', adminReportsKeyboard());
    }

    else if (action === 'cat_gift') {
      db.clearPendingAction(chatId);
      await sendOrEditAdmin(chatId, messageId, '🎁 *Gift (Userbot)*\n\nPilih menu di bawah:', adminGiftKeyboard());
    }

    else if (action === 'giftemoji') {
      db.clearPendingAction(chatId);
      const keyboard = await adminGiftEmojiListKeyboard();
      await sendOrEditAdmin(chatId, messageId, adminGiftEmojiListText(), keyboard, 'HTML');
    }

    else if (action === 'gift_balance') {
      db.clearPendingAction(chatId);
      if (!userbot.isConfigured()) {
        await sendOrEditAdmin(chatId, messageId, '⚠️ Userbot belum dikonfigurasi (USERBOT_SESSION kosong di .env). Lihat userbot-login.js.', adminBackKeyboard('admin:cat_gift'));
        return;
      }
      try {
        const stars = await userbot.getUserbotStarsBalance(true); // forceRefresh - admin mau angka terbaru
        const lowWarning = stars < GIFT_LOW_STARS_THRESHOLD
          ? `\n\n⚠️ Saldo di bawah ambang batas (${GIFT_LOW_STARS_THRESHOLD}⭐) - buyer bisa mulai kena "Stars habis". Top up segera lewat Settings > Stars di akun userbot.`
          : '';
        await sendOrEditAdmin(chatId, messageId, `🌟 *Saldo Stars Userbot*\n\n${stars}⭐${lowWarning}`, adminBackKeyboard('admin:cat_gift'));
      } catch (err) {
        logError('admin:gift_balance', err);
        await sendOrEditAdmin(chatId, messageId, `❌ Gagal cek saldo Stars: ${escapeHtml(String(err.message || err))}`, adminBackKeyboard('admin:cat_gift'));
      }
    }

    else if (action === 'gift_history') {
      db.clearPendingAction(chatId);
      const db_ = db.readDb();
      const orders = (db_.giftOrders || []).slice(-20).reverse();
      if (!orders.length) {
        await sendOrEditAdmin(chatId, messageId, '📜 *Riwayat Gift Order*\n\nBelum ada order gift sama sekali.', adminBackKeyboard('admin:cat_gift'));
        return;
      }
      const statusIcon = { pending: '⏳', sent: '✅', failed_refunded: '❌' };
      const lines = orders.map(o => {
        const who = o.username ? `@${escapeHtml(o.username)}` : `ID ${o.chatId}`;
        const modeLabel = o.mode === 'confess' ? '💌 Confess' : (o.mode === 'saved' ? '🎨 Koleksi' : '🎁 Buy');
        return `${statusIcon[o.status] || '❔'} ${modeLabel} ${o.stars}⭐ - ${who} → <code>${escapeHtml(String(o.target))}</code> (${usd(o.priceUsd, chatId)})`;
      });
      await sendOrEditAdmin(chatId, messageId, `📜 *Riwayat Gift Order* (${orders.length} terakhir)\n\n${lines.join('\n')}`, adminBackKeyboard('admin:cat_gift'), 'HTML');
    }

    else if (action === 'giftpricing') {
      db.clearPendingAction(chatId);
      await sendOrEditAdmin(chatId, messageId, adminGiftPricingText(), adminGiftPricingKeyboard(), 'HTML');
    }

    else if (action === 'giftpricingmarkup') {
      db.setPendingAction(chatId, { type: 'set_gift_markup' });
      const pricing = db.getGiftPricingSettings();
      const current = pricing.markupPct != null ? pricing.markupPct : GIFT_MARKUP_PCT;
      await sendOrEditAdmin(chatId, messageId,
        `📈 *Ubah Markup Gift*\n\nMarkup sekarang: *${current}%*\n\nKetik markup baru dalam persen (angka saja, contoh: \`30\`). Ketik /cancel untuk batal.`,
        adminBackKeyboard('admin:giftpricing')
      );
    }

    else if (action === 'giftpricingrate') {
      db.setPendingAction(chatId, { type: 'set_gift_stars_rate' });
      const pricing = db.getGiftPricingSettings();
      const current = pricing.starsToUsdRate != null ? pricing.starsToUsdRate : STARS_TO_USD_RATE;
      await sendOrEditAdmin(chatId, messageId,
        `💱 *Ubah Kurs Stars→USD*\n\nKurs sekarang: *${current}* (artinya 1⭐ = $${current})\n\nKetik kurs baru (angka desimal, contoh: \`0.015\`). Ketik /cancel untuk batal.`,
        adminBackKeyboard('admin:giftpricing')
      );
    }

    else if (action === 'giftpricingreset') {
      db.clearPendingAction(chatId);
      db.setGiftPricingSettings({ markupPct: null, starsToUsdRate: null });
      await sendOrEditAdmin(chatId, messageId, `✅ Harga gift direset ke default .env.\n\n${adminGiftPricingText()}`, adminGiftPricingKeyboard(), 'HTML');
    }

    else if (action === 'cat_settings') {
      db.clearPendingAction(chatId);
      await sendOrEditAdmin(chatId, messageId, '⚙️ *Pengaturan Toko*\n\nPilih menu di bawah:', adminSettingsKeyboard());
    }

    else if (action === 'forcejoin') {
      db.clearPendingAction(chatId);
      await sendOrEditAdmin(chatId, messageId, adminForceJoinText(), adminForceJoinKeyboard());
    }

    else if (action === 'forcejoin_toggle') {
      const { enabled } = db.getForceJoinSettings();
      db.setForceJoinEnabled(!enabled);
      await sendOrEditAdmin(chatId, messageId, adminForceJoinText(), adminForceJoinKeyboard());
      await bot.answerCallbackQuery(query.id, { text: !enabled ? '🟢 Wajib Join diaktifkan!' : '🔴 Wajib Join dinonaktifkan.' }).catch(() => {});
    }

    else if (action === 'forcejoin_add') {
      db.setPendingAction(chatId, { type: 'forcejoin_add_link' });
      await sendOrEditAdmin(chatId, messageId,
        '➕ *Tambah Channel/Grup Wajib Join*\n\n*Langkah 1/2* - Kirim link undangan/publik channel atau grup-nya, contoh:\n`https://t.me/namachannel`\natau link invite private (channel maupun grup):\n`https://t.me/+AbCdEfGhIjK`\n\nKetik /cancel untuk batal.',
        adminBackKeyboard('admin:cat_settings')
      );
    }

    else if (action === 'forcejoin_remove') {
      const removed = db.removeForceJoinChannel(param);
      await sendOrEditAdmin(chatId, messageId, adminForceJoinText(), adminForceJoinKeyboard());
      await bot.answerCallbackQuery(query.id, { text: removed ? '🗑️ Channel dihapus.' : '⚠️ Channel tidak ditemukan.' }).catch(() => {});
    }

    else if (action === 'channelnotif') {
      db.clearPendingAction(chatId);
      await sendOrEditAdmin(chatId, messageId, adminChannelNotifText(), adminChannelNotifKeyboard());
    }

    else if (action === 'channelnotif_toggle') {
      const current = db.getChannelNotifSettings();
      if (!current.enabled && !current.chatRef) {
        return bot.answerCallbackQuery(query.id, { text: '⚠️ Set dulu Channel Tujuan sebelum mengaktifkan.', show_alert: true });
      }
      db.setChannelNotifSettings({ enabled: !current.enabled });
      await sendOrEditAdmin(chatId, messageId, adminChannelNotifText(), adminChannelNotifKeyboard());
      await bot.answerCallbackQuery(query.id, { text: !current.enabled ? '🟢 Notifikasi channel diaktifkan!' : '🔴 Notifikasi channel dinonaktifkan.' }).catch(() => {});
    }

    else if (action === 'channelnotif_toggle_purchase') {
      const current = db.getChannelNotifSettings();
      db.setChannelNotifSettings({ notifyPurchase: !current.notifyPurchase });
      await sendOrEditAdmin(chatId, messageId, adminChannelNotifText(), adminChannelNotifKeyboard());
      await bot.answerCallbackQuery(query.id).catch(() => {});
    }

    else if (action === 'channelnotif_toggle_topup') {
      const current = db.getChannelNotifSettings();
      db.setChannelNotifSettings({ notifyTopup: !current.notifyTopup });
      await sendOrEditAdmin(chatId, messageId, adminChannelNotifText(), adminChannelNotifKeyboard());
      await bot.answerCallbackQuery(query.id).catch(() => {});
    }

    else if (action === 'channelnotif_toggle_referral') {
      const current = db.getChannelNotifSettings();
      db.setChannelNotifSettings({ notifyReferral: !current.notifyReferral });
      await sendOrEditAdmin(chatId, messageId, adminChannelNotifText(), adminChannelNotifKeyboard());
      await bot.answerCallbackQuery(query.id).catch(() => {});
    }

    else if (action === 'channelnotif_toggle_maintenance') {
      const current = db.getChannelNotifSettings();
      db.setChannelNotifSettings({ notifyMaintenance: !current.notifyMaintenance });
      await sendOrEditAdmin(chatId, messageId, adminChannelNotifText(), adminChannelNotifKeyboard());
      await bot.answerCallbackQuery(query.id).catch(() => {});
    }

    else if (action === 'channelnotif_setchannel') {
      db.setPendingAction(chatId, { type: 'channelnotif_setchannel' });
      await sendOrEditAdmin(chatId, messageId,
        '🆔 *Set Channel Tujuan Notifikasi*\n\n' +
        'Kirim *Username channel/group* (contoh: `@namachannel`) ATAU *Chat ID numerik* (contoh: `-1001234567890`).\n\n' +
        '💡 Untuk channel/group *private* (tidak punya username publik), WAJIB pakai Chat ID numerik. Cara dapat Chat ID: tambahkan bot ini sebagai admin di channel/group tujuan, lalu forward pesan apapun dari situ ke @userinfobot / @RawDataBot.\n\n' +
        '⚠️ Bot WAJIB sudah jadi admin di channel/group tersebut, kalau tidak pengiriman notifikasi akan gagal.\n\nKetik /cancel untuk batal.',
        adminBackKeyboard('admin:cat_settings')
      );
    }

    else if (action === 'channelnotif_test') {
      const settings = db.getChannelNotifSettings();
      if (!settings.chatRef) {
        return bot.answerCallbackQuery(query.id, { text: '⚠️ Set dulu Channel Tujuan.', show_alert: true });
      }
      const sampleProduct = db.findProduct('gemini-pro-18-bulan') || { name: 'Gemini Pro', emoji: '🔍', emojiId: null };
      const sampleVariant = (sampleProduct.variants && sampleProduct.variants[0]) || { label: '18 Months' };
      const sampleText = buildChannelPurchaseText(chatId, sampleProduct, sampleVariant, 100, 49.99);
      try {
        await bot.sendMessage(settings.chatRef, sampleText, { parse_mode: 'HTML', reply_markup: channelNotifKeyboard() });
        await bot.answerCallbackQuery(query.id, { text: '✅ Contoh notifikasi terkirim ke channel!' }).catch(() => {});
      } catch (err) {
        console.error('Gagal kirim contoh notifikasi channel:', err.message);
        await bot.answerCallbackQuery(query.id, { text: `⚠️ Gagal kirim: ${err.message}`, show_alert: true }).catch(() => {});
      }
    }

    else if (action === 'channelnotif_test_referral') {
      const settings = db.getChannelNotifSettings();
      if (!settings.chatRef) {
        return bot.answerCallbackQuery(query.id, { text: '⚠️ Set dulu Channel Tujuan.', show_alert: true });
      }
      const sampleText = buildChannelReferralText(chatId, chatId, REFERRAL_REWARD);
      try {
        await bot.sendMessage(settings.chatRef, sampleText, { parse_mode: 'HTML', reply_markup: channelNotifKeyboard() });
        await bot.answerCallbackQuery(query.id, { text: '✅ Contoh notifikasi terkirim ke channel!' }).catch(() => {});
      } catch (err) {
        console.error('Gagal kirim contoh notifikasi channel:', err.message);
        await bot.answerCallbackQuery(query.id, { text: `⚠️ Gagal kirim: ${err.message}`, show_alert: true }).catch(() => {});
      }
    }

    else if (action === 'listproducts') {
      const products = db.getAllProducts();
      const text = products.map(p =>
        `${productEmojiHtml(p)} <b>${escapeHtml(p.name)}</b> (id: <code>${escapeHtml(p.id)}</code>)\n` +
        (p.variants.length
          ? p.variants.map(v => {
              const autoCount = db.getStockItemCount(p.id, v.id);
              const autoTag = Array.isArray(v.stockItems) ? ` 🤖 auto-kirim: ${autoCount}` : '';
              const supplierTag = v.supplierServiceId ? ` API: ${escapeHtml(v.supplierServiceId)}` : '';
              const canbosoTag = v.canbosoProductId ? ` Canboso: ${escapeHtml(String(v.canbosoProductId))}` : '';
              return `   - ${escapeHtml(v.label)}: mulai ${usd(db.getBasePrice(v))}, stok ${db.getTotalStock(v)} (id: ${escapeHtml(v.id)})${autoTag}${supplierTag}${canbosoTag}`;
            }).join('\n')
          : '   (belum ada varian)')
      ).join('\n\n') || 'Belum ada produk.';
      await sendOrEditAdmin(chatId, messageId, `📦 <b>Daftar Produk</b>\n\n${text}`, adminBackKeyboard('admin:cat_products'), 'HTML');
    }

    else if (action === 'addproduct') {
      db.setPendingAction(chatId, { type: 'addproduct_name' });
      await sendOrEditAdmin(chatId, messageId,
        '➕ *Tambah Produk*\n\nCukup 3 langkah: nama → harga → deskripsi.\n\n' +
        'Ketik *emoji premium* (pilih langsung dari panel emoji Telegram Premium kamu) diikuti *nama produk*, contoh:\n' +
        '`✨ Gemini Pro 18 Bulan`\n\n' +
        '⚠️ Emoji-nya wajib dipilih dari panel emoji Telegram Premium kamu sendiri (bukan cuma ngetik unicode biasa), supaya kesimpan sebagai emoji premium asli. Kalau dilewati / owner belum Premium, produk tetap dibuat pakai emoji default 📦.',
        adminBackKeyboard('admin:cat_products')
      );
    }

    else if (action === 'addvariant') {
      await sendOrEditAdmin(chatId, messageId, '➕ *Tambah Varian*\n\nPilih produk tujuan:', adminProductPickKeyboard('addvariant_pick'));
    }
    else if (action === 'addvariant_pick') {
      const product = db.findProduct(param);
      if (!product) return bot.answerCallbackQuery(query.id, { text: 'Produk tidak ditemukan.' });
      db.setPendingAction(chatId, { type: 'addvariant_label', data: { productId: param } });
      await sendOrEditAdmin(chatId, messageId, `➕ Tambah varian untuk *${product.name}*\n\nKetik label varian (contoh: "18 Bulan"):`, adminBackKeyboard('admin:cat_products'));
    }

    else if (action === 'setprice') {
      const productsWithVariants = db.getAllProducts().filter(p => p.variants.length > 0);
      if (!productsWithVariants.length) {
        await sendOrEditAdmin(chatId, messageId, '💲 *Set Harga Produk*\n\nBelum ada produk dengan varian. Tambah produk dulu lewat ➕ Tambah Produk.', adminBackKeyboard('admin:cat_products'));
      } else {
        await sendOrEditAdmin(chatId, messageId, '💲 *Set Harga Produk*\n\nPilih produk yang mau diubah harganya:', adminProductPickKeyboard('setprice_pick', productsWithVariants));
      }
    }
    else if (action === 'setprice_pick') {
      const product = db.findProduct(param);
      if (!product || !product.variants.length) {
        return sendOrEditAdmin(chatId, messageId, `⚠️ Produk *${product ? product.name : param}* belum punya varian.`, adminBackKeyboard('admin:cat_products'));
      }
      if (product.variants.length === 1) {
        const variant = product.variants[0];
        db.setPendingAction(chatId, { type: 'setprice_amount', data: { productId: param, variantId: variant.id } });
        await sendOrEditAdmin(chatId, messageId,
          `💲 *Set Harga - ${product.name}*\n\nHarga saat ini: ${usd(db.getBasePrice(variant))}\n\nKetik harga baru dalam USD (angka saja, boleh desimal, contoh: \`5\` atau \`5.99\`). Ketik /cancel untuk batal.`,
          adminBackKeyboard('admin:cat_products')
        );
      } else {
        await sendOrEditAdmin(chatId, messageId, `💲 Set harga untuk *${product.name}*\n\nPilih varian:`, adminVariantPickKeyboard(product, 'setprice_variant', 'admin:setprice'));
      }
    }
    else if (action === 'setprice_variant') {
      const product = db.findProduct(param);
      const variant = product && product.variants[Number(parts[3])];
      if (!product || !variant) return bot.answerCallbackQuery(query.id, { text: 'Varian tidak ditemukan.' });
      const variantId = variant.id;
      db.setPendingAction(chatId, { type: 'setprice_amount', data: { productId: param, variantId } });
      await sendOrEditAdmin(chatId, messageId,
        `💲 *Set Harga - ${product.name} ${variant.label}*\n\nHarga saat ini: ${usd(db.getBasePrice(variant))}\n\nKetik harga baru dalam USD (angka saja, boleh desimal, contoh: \`5\` atau \`5.99\`). Ketik /cancel untuk batal.`,
        adminBackKeyboard('admin:cat_products')
      );
    }

    // Set tier diskon grosir (1-49 / 50-499 / 500+) langsung pakai harga USD
    // manual - berlaku untuk SEMUA varian (produk manual maupun yang
    // terhubung Supplier API). Beda dengan "📊 Atur Markup 3-Tier" (khusus
    // Supplier API, lihat action 'suppliertiermarkup') yang inputnya PERSEN
    // markup dari modal - fitur ini inputnya harga JUAL langsung per tier,
    // jadi cocok juga dipakai produk manual yang tidak punya modal Supplier.
    else if (action === 'settierprice') {
      const productsWithVariants = db.getAllProducts().filter(p => p.variants.length > 0);
      if (!productsWithVariants.length) {
        await sendOrEditAdmin(chatId, messageId, '🎁 *Set Tier Diskon Grosir*\n\nBelum ada produk dengan varian. Tambah produk dulu lewat ➕ Tambah Produk.', adminBackKeyboard('admin:cat_products'));
      } else {
        await sendOrEditAdmin(chatId, messageId, '🎁 *Set Tier Diskon Grosir*\n\nPilih produk yang mau diatur tier harganya:', adminProductPickKeyboard('settierprice_pick', productsWithVariants));
      }
    }
    else if (action === 'settierprice_pick') {
      const product = db.findProduct(param);
      if (!product || !product.variants.length) {
        return sendOrEditAdmin(chatId, messageId, `⚠️ Produk *${product ? product.name : param}* belum punya varian.`, adminBackKeyboard('admin:cat_products'));
      }
      if (product.variants.length === 1) {
        const variant = product.variants[0];
        askSetTierPrice(chatId, messageId, product, variant);
      } else {
        await sendOrEditAdmin(chatId, messageId, `🎁 Set tier diskon untuk *${product.name}*\n\nPilih varian:`, adminVariantPickKeyboard(product, 'settierprice_variant', 'admin:settierprice'));
      }
    }
    else if (action === 'settierprice_variant') {
      const product = db.findProduct(param);
      const variant = product && product.variants[Number(parts[3])];
      if (!product || !variant) return bot.answerCallbackQuery(query.id, { text: 'Varian tidak ditemukan.' });
      askSetTierPrice(chatId, messageId, product, variant);
    }

    // Toggle "🔒 Kunci Harga Manual" per varian - dipanggil dari tombol di
    // askSetTierPrice() (khusus varian Supplier API). Kalau dikunci,
    // refreshSupplierData() skip perhitungan ulang tier dari markup tapi
    // tetap sinkron modal & stok seperti biasa (lihat komentarnya di sana).
    else if (action === 'pricelocktoggle') {
      const product = db.findProduct(param);
      const variant = product && product.variants[Number(parts[3])];
      if (!product || !variant) return bot.answerCallbackQuery(query.id, { text: 'Varian tidak ditemukan.' });
      const newLocked = !variant.priceLocked;
      db.setVariantPriceLock(product.id, variant.id, newLocked);
      variant.priceLocked = newLocked; // biar askSetTierPrice() di bawah langsung pakai status baru, bukan yang basi di memori
      bot.answerCallbackQuery(query.id, { text: newLocked ? '🔒 Harga manual dikunci.' : '🔓 Kunci dibuka.' });
      askSetTierPrice(chatId, messageId, product, variant);
    }

    else if (action === 'setdesc') {
      await sendOrEditAdmin(chatId, messageId, '📝 *Set Description*\n\nPick the product whose description you want to set:', adminProductPickKeyboard('setdesc_pick'));
    }
    else if (action === 'setdesc_pick') {
      const product = db.findProduct(param);
      if (!product || !product.variants.length) {
        return sendOrEditAdmin(chatId, messageId,
          `⚠️ Product *${product ? product.name : param}* has no variants yet. Add one first via ➕ Add Variant.`,
          adminBackKeyboard('admin:cat_products')
        );
      }
      if (product.variants.length === 1) {
        const variant = product.variants[0];
        db.setPendingAction(chatId, { type: 'setdesc_text', data: { productId: param, variantId: variant.id } });
        await sendOrEditAdmin(chatId, messageId,
          `📝 *Set Description - ${product.name}*\n\n` +
          (variant.description ? `Current description:\n${variant.description}\n\n` : 'No description yet.\n\n') +
          DESC_INPUT_PROMPT,
          adminBackKeyboard('admin:cat_products')
        );
      } else {
        await sendOrEditAdmin(chatId, messageId, `📝 Set Description for *${product.name}*\n\nPick a variant:`, adminVariantPickKeyboard(product, 'setdesc_variant', 'admin:setdesc'));
      }
    }
    else if (action === 'setdesc_variant') {
      const product = db.findProduct(param);
      const variant = product && product.variants[Number(parts[3])];
      if (!product || !variant) return bot.answerCallbackQuery(query.id, { text: 'Variant not found.' });
      const variantId = variant.id;
      db.setPendingAction(chatId, { type: 'setdesc_text', data: { productId: param, variantId } });
      await sendOrEditAdmin(chatId, messageId,
        `📝 *Set Description - ${product.name} ${variant.label}*\n\n` +
        (variant.description ? `Current description:\n${variant.description}\n\n` : 'No description yet.\n\n') +
        DESC_INPUT_PROMPT,
        adminBackKeyboard('admin:cat_products')
      );
    }

    else if (action === 'setlogo') {
      await sendOrEditAdmin(chatId, messageId, '🖼️ *Set Logo Produk*\n\nPilih produk yang mau diatur logo aplikasinya:', adminProductPickKeyboard('setlogo_pick'));
    }
    else if (action === 'setlogo_pick') {
      const product = db.findProduct(param);
      if (!product) return bot.answerCallbackQuery(query.id, { text: 'Produk tidak ditemukan.' });
      db.setPendingAction(chatId, { type: 'setlogo_url', data: { productId: param } });
      await sendOrEditAdmin(chatId, messageId,
        `🖼️ *Set Logo - ${product.name}*\n\n` +
        (product.logoUrl ? `Logo saat ini:\n${product.logoUrl}\n\n` : 'Belum ada logo, masih pakai emoji biasa.\n\n') +
        'Kirim URL gambar logo aplikasi ini (harus diawali `http://` atau `https://`, contoh: link logo resmi Netflix/Spotify/Gemini yang kamu hosting sendiri). Logo ini dipakai di notifikasi channel (📣 New Purchase) supaya tampil sebagai gambar, bukan cuma emoji.\n\n' +
        'Ketik `-` untuk menghapus logo (balik pakai emoji biasa), atau /cancel untuk batal.',
        adminBackKeyboard('admin:cat_products')
      );
    }

    else if (action === 'setemoji') {
      await sendOrEditAdmin(chatId, messageId, '😀 *Ganti Emoji Produk*\n\nPilih produk yang mau diganti ikonnya:', adminProductPickKeyboard('setemoji_pick'));
    }
    else if (action === 'setemoji_pick') {
      const product = db.findProduct(param);
      if (!product) return bot.answerCallbackQuery(query.id, { text: 'Produk tidak ditemukan.' });
      db.setPendingAction(chatId, { type: 'setemoji_capture', data: { productId: param } });
      await sendOrEditAdmin(chatId, messageId,
        `😀 *Ganti Emoji - ${product.name}*\n\n` +
        `Ikon saat ini: ${product.emojiId ? `<tg-emoji emoji-id="${product.emojiId}">${product.emoji || '📦'}</tg-emoji>` : (product.emoji || '📦')}\n\n` +
        'Kirim (boleh forward dari chat lain) 1 pesan yang mengandung 1 *emoji premium* — WAJIB dipilih langsung dari panel emoji Telegram Premium kamu sendiri (bukan cuma ngetik/paste unicode biasa), supaya ID-nya ke-capture asli dan tersimpan sebagai premium.\n\n' +
        '💡 Tips: buka panel emoji di Telegram, cari kata kunci sesuai produknya (mis. "cart"/"keranjang", "netflix", "music"), lalu pilih salah satu hasilnya sebelum dikirim - jangan asal pilih ikon yang MIRIP tapi ternyata beda gambar.\n\n' +
        'Atau ketik `-` untuk balik ke emoji unicode biasa (📦, tanpa premium). Ketik /cancel untuk batal.',
        adminBackKeyboard('admin:cat_products'), 'HTML'
      );
    }

    else if (action === 'sethowto') {
      await sendOrEditAdmin(chatId, messageId, '✏️ *Set How to Use*\n\nPilih produk yang mau diatur teks "How to Use"-nya:', adminProductPickKeyboard('sethowto_pick'));
    }
    else if (action === 'sethowto_pick') {
      const product = db.findProduct(param);
      if (!product || !product.variants.length) {
        return sendOrEditAdmin(chatId, messageId,
          `⚠️ Produk *${product ? product.name : param}* belum punya varian. Tambah variannya dulu lewat ➕ Tambah Varian.`,
          adminBackKeyboard('admin:cat_products')
        );
      }
      if (product.variants.length === 1) {
        const variant = product.variants[0];
        db.setPendingAction(chatId, { type: 'sethowto_text', data: { productId: param, variantId: variant.id } });
        await sendOrEditAdmin(chatId, messageId,
          `✏️ *Set How to Use - ${product.name}*\n\n` +
          (variant.howToUse ? `Teks saat ini:\n${variant.howToUse}\n\n` : 'Belum ada teks How to Use.\n\n') +
          'Ketik teks *How to Use* yang baru (bebas banyak baris, boleh tag HTML `<b>...</b>` untuk bold. Kalau kamu pilih emoji premium langsung dari panel Telegram Premium kamu sendiri, emoji itu otomatis kesimpan sebagai premium juga - nggak perlu setting ID manual). Ketik /cancel untuk batal.',
          adminBackKeyboard('admin:cat_products')
        );
      } else {
        await sendOrEditAdmin(chatId, messageId, `✏️ Set How to Use untuk *${product.name}*\n\nPilih varian:`, adminVariantPickKeyboard(product, 'sethowto_variant', 'admin:sethowto'));
      }
    }
    else if (action === 'sethowto_variant') {
      const product = db.findProduct(param);
      const variant = product && product.variants[Number(parts[3])];
      if (!product || !variant) return bot.answerCallbackQuery(query.id, { text: 'Varian tidak ditemukan.' });
      const variantId = variant.id;
      db.setPendingAction(chatId, { type: 'sethowto_text', data: { productId: param, variantId } });
      await sendOrEditAdmin(chatId, messageId,
        `✏️ *Set How to Use - ${product.name} ${variant.label}*\n\n` +
        (variant.howToUse ? `Teks saat ini:\n${variant.howToUse}\n\n` : 'Belum ada teks How to Use.\n\n') +
        'Ketik teks *How to Use* yang baru. Ketik /cancel untuk batal.',
        adminBackKeyboard('admin:cat_products')
      );
    }

    else if (action === 'addstock') {
      const productsWithVariants = db.getAllProducts().filter(p => p.variants.length > 0);
      if (!productsWithVariants.length) {
        await sendOrEditAdmin(chatId, messageId, '📥 *Tambah Stock*\n\nBelum ada produk dengan varian. Tambah varian dulu lewat ➕ Tambah Varian.', adminBackKeyboard('admin:cat_products'));
      } else {
        await sendOrEditAdmin(chatId, messageId, '📥 *Tambah Stock*\n\nPilih produk tujuan:', adminProductPickKeyboard('addstock_pick', productsWithVariants));
      }
    }
    else if (action === 'addstock_pick') {
      const product = db.findProduct(param);
      if (!product || !product.variants.length) {
        // Fallback aman: kalau somehow produk tanpa varian masih ke-klik,
        // jangan cuma toast sekilas - kasih pesan jelas + arahkan langkah berikutnya.
        return sendOrEditAdmin(chatId, messageId,
          `⚠️ Produk *${product ? product.name : param}* belum punya varian, jadi belum bisa diisi stok.\n\nTambah variannya dulu lewat menu ➕ Tambah Varian, baru bisa isi stok di sini.`,
          adminBackKeyboard('admin:cat_products')
        );
      }
      if (product.variants.length === 1) {
        // Produk single-varian (hasil "➕ Tambah Produk" biasa) -> langsung
        // masuk ke layar pilih cara (📋 link/kode vs 🔢 angka manual),
        // tidak perlu pilih varian lagi.
        const variant = product.variants[0];
        db.clearPendingAction(chatId);
        await sendOrEditAdmin(chatId, messageId,
          addStockModeText(product.name, variant.label, db.getTotalStock(variant)),
          addStockModeKeyboard(param, variant.id)
        );
      } else {
        await sendOrEditAdmin(chatId, messageId, `📥 Tambah stok untuk *${product.name}*\n\nPilih varian tujuan:`, adminVariantPickKeyboard(product, 'addstock_variant'));
      }
    }
    else if (action === 'addstock_variant') {
      const product = db.findProduct(param);
      const variant = product && product.variants[Number(parts[3])];
      if (!product || !variant) return bot.answerCallbackQuery(query.id, { text: 'Varian tidak ditemukan.' });
      db.clearPendingAction(chatId);
      await sendOrEditAdmin(chatId, messageId,
        addStockModeText(product.name, variant.label, db.getTotalStock(variant)),
        addStockModeKeyboard(param, variant.id)
      );
    }
    else if (action === 'addstockmode') {
      // callback_data: admin:addstockmode:<ref>:<items|qty> - ref = productRef(productId, variantId)
      const ref = param;
      const mode = parts[3];
      const resolved = resolveProductRef(ref);
      const product = resolved && db.findProduct(resolved.productId);
      const variant = product && product.variants.find(v => v.id === resolved.variantId);
      if (!product || !variant) {
        return sendOrEditAdmin(chatId, messageId, '⚠️ Product/variant not found, cancelled.', adminBackKeyboard('admin:cat_products'));
      }
      if (mode === 'items') {
        db.setPendingAction(chatId, { type: 'addstock_items', data: { productId: product.id, variantId: variant.id } });
        await sendOrEditAdmin(chatId, messageId,
          stockInstructionsText(product.name, variant.label, db.getTotalStock(variant)),
          adminBackKeyboard('admin:cat_products')
        );
      } else if (mode === 'qty') {
        db.setPendingAction(chatId, { type: 'addstock_manual_qty', data: { productId: product.id, variantId: variant.id } });
        await sendOrEditAdmin(chatId, messageId,
          `🔢 *Tambah Stock Manual - ${product.variants.length > 1 ? `${product.name} - ${variant.label}` : product.name}*\n\n` +
          `📦 Total stok saat ini: *${db.getTotalStock(variant)}*\n\n` +
          `Ketik JUMLAH stok yang mau ditambahkan (angka saja, mis. \`10\`). Stok ini TANPA link/kode - buyer yang beli tetap dapat pesan "ORDER BERHASIL!", tapi kamu yang kirim akun/detailnya manual.\n\n` +
          `Ketik /cancel untuk batal.`,
          adminBackKeyboard('admin:cat_products'),
          'Markdown'
        );
      }
    }

    // ===== Supplier API =====
    // Hubungkan 1 varian produk lokal ke 1 service_id di Supplier supaya
    // pembelian buyer otomatis dipenuhi lewat API mereka. Lihat supplier.js
    // untuk integrasi API-nya & alur "confirm:" di atas untuk pemakaiannya.
    else if (action === 'supplier') {
      db.clearPendingAction(chatId);
      await sendOrEditAdmin(chatId, messageId, await supplierMenuText(), await supplierMenuKeyboard());
    }

    else if (action === 'supplierlink') {
      const productsWithVariants = db.getAllProducts().filter(p => p.variants.length > 0);
      if (!productsWithVariants.length) {
        await sendOrEditAdmin(chatId, messageId, '*Hubungkan Produk ke Supplier API*\n\nBelum ada produk dengan varian. Tambah varian dulu lewat ➕ Tambah Varian.', supplierBackKeyboard());
      } else {
        await sendOrEditAdmin(chatId, messageId, '*Hubungkan Produk ke Supplier API*\n\nPilih produk lokal yang mau dihubungkan:', adminProductPickKeyboard('supplierlink_pick', productsWithVariants));
      }
    }
    else if (action === 'supplierlink_pick') {
      const product = db.findProduct(param);
      if (!product || !product.variants.length) {
        return sendOrEditAdmin(chatId, messageId, `⚠️ Produk *${product ? product.name : param}* belum punya varian.`, supplierBackKeyboard());
      }
      if (product.variants.length === 1) {
        await showSupplierServicePicker(chatId, messageId, param, product.variants[0].id);
      } else {
        await sendOrEditAdmin(chatId, messageId, `Hubungkan varian mana dari *${product.name}*?`, adminVariantPickKeyboard(product, 'supplierlink_variant', 'admin:supplierlink'));
      }
    }
    else if (action === 'supplierlink_variant') {
      const product = db.findProduct(param);
      const variant = product && product.variants[Number(parts[3])];
      if (!product || !variant) return bot.answerCallbackQuery(query.id, { text: 'Varian tidak ditemukan.' });
      await showSupplierServicePicker(chatId, messageId, param, variant.id);
    }
    else if (action === 'supplierlink_set') {
      const idx = Number(param);
      const pending = db.getPendingAction(chatId);
      if (!pending || pending.type !== 'supplier_link_pick' || !pending.data.services[idx]) {
        return bot.answerCallbackQuery(query.id, { text: '⚠️ Sesi pilih service sudah kadaluarsa, ulangi lagi dari Supplier API.', show_alert: true });
      }
      const { productId, variantId, services } = pending.data;
      const service = services[idx];
      const product = db.findProduct(productId);
      const variant = product && product.variants.find(v => v.id === variantId);
      db.clearPendingAction(chatId);
      if (!product || !variant) {
        return sendOrEditAdmin(chatId, messageId, '⚠️ Produk/varian tidak ditemukan lagi, dibatalkan.', supplierBackKeyboard());
      }
      const cost = typeof service.price === 'number' ? service.price : parseFloat(service.price);
      db.setVariantSupplier(productId, variantId, service.service_id, cost);
      // Sinkron stok lokal ke stok live Supplier begitu link dibuat,
      // supaya menu admin nggak nampilin angka manual lama yang sudah tidak
      // relevan lagi buat varian bersupplier ini.
      const liveStockOnLink = Number(service.stock);
      if (!isNaN(liveStockOnLink)) db.setVariantStock(productId, variantId, liveStockOnLink);
      // Langsung hitung 3 tier harga jual dari modal + markup% (config.js
      // DEFAULT_SUPPLIER_TIER_MARKUP / variant.tierMarkup) SAAT link dibuat -
      // supaya buyer tidak sempat lihat tier lama/manual yang sudah basi
      // sambil nunggu jadwal auto-sync berikutnya. Admin tetap bisa override
      // pakai tombol markup cepat / harga custom di bawah kalau mau harga
      // flat (bukan 3 tier) untuk varian ini.
      if (!isNaN(cost) && cost > 0) {
        const initialMarkup = db.getVariantTierMarkup(variant, DEFAULT_SUPPLIER_TIER_MARKUP);
        const initialTiers = computeTiersFromCost(cost, initialMarkup);
        db.setVariantTiers(productId, variantId, initialTiers);
        variant.tiers = initialTiers;
      }
      const currentSellPrice = db.getBasePrice(variant);
      await sendOrEditAdmin(chatId, messageId,
        `✅ *${product.name}${variant.label ? ' - ' + variant.label : ''}* berhasil dihubungkan ke Supplier API!\n\n` +
        `Service ID: \`${service.service_id}\`\n🌐 Nama di Supplier: ${service.name || '-'}\n\n` +
        `Mulai sekarang, tiap ada buyer beli varian ini, bot akan otomatis pesan lewat Supplier dan langsung teruskan hasilnya ke buyer - stok lokal/manual varian ini (kalau ada) tetap dipakai LEBIH DULU, baru sisa kekurangannya dipesan otomatis ke Supplier.\n\n` +
        `${marginText(cost, currentSellPrice)}\n\n` +
        `Mau atur harga jual sekarang? Pilih markup cepat dari modal (${typeof cost === 'number' && !isNaN(cost) ? usd(cost) : '?'}), atau isi harga custom - atau langsung "Selesai" kalau harga jual sekarang sudah pas.`,
        supplierLinkPriceKeyboard(chatId, productId, variantId)
      );
    }
    else if (action === 'supplierlinkmarkup') {
      const pct = Number(param);
      const priceCtx = db.getPendingAction(chatId);
      if (!priceCtx || priceCtx.type !== 'supplier_link_price_ctx') {
        return bot.answerCallbackQuery(query.id, { text: '⚠️ Sesi sudah kadaluarsa, ulangi lagi dari Supplier API.', show_alert: true });
      }
      const { productId, variantId } = priceCtx.data;
      const product = db.findProduct(productId);
      const variant = product && product.variants.find(v => v.id === variantId);
      if (!product || !variant) return bot.answerCallbackQuery(query.id, { text: 'Varian tidak ditemukan.' });
      const cost = variant.supplierCost;
      if (typeof cost !== 'number' || isNaN(cost)) {
        return bot.answerCallbackQuery(query.id, { text: '⚠️ Harga modal tidak diketahui untuk varian ini (linked sebelum fitur ini ada) - pakai ✏️ Harga Custom saja.', show_alert: true });
      }
      const newPrice = Math.round(cost * (1 + pct / 100) * 100) / 100;
      db.setVariantPrice(productId, variantId, newPrice);
      await bot.answerCallbackQuery(query.id, { text: `✅ Harga jual di-set ${usd(newPrice)} (modal +${pct}%)` }).catch(() => {});
      await sendOrEditAdmin(chatId, messageId,
        `✅ Harga jual *${product.name}${variant.label ? ' - ' + variant.label : ''}* di-set ke ${usd(newPrice)}.\n\n${marginText(cost, newPrice)}`,
        supplierLinkPriceKeyboard(chatId, productId, variantId)
      );
    }
    else if (action === 'supplierlinkcustomprice') {
      const priceCtx = db.getPendingAction(chatId);
      if (!priceCtx || priceCtx.type !== 'supplier_link_price_ctx') {
        return bot.answerCallbackQuery(query.id, { text: '⚠️ Sesi sudah kadaluarsa, ulangi lagi dari Supplier API.', show_alert: true });
      }
      const { productId, variantId } = priceCtx.data;
      const product = db.findProduct(productId);
      const variant = product && product.variants.find(v => v.id === variantId);
      if (!product || !variant) return bot.answerCallbackQuery(query.id, { text: 'Varian tidak ditemukan.' });
      db.setPendingAction(chatId, { type: 'setprice_amount', data: { productId, variantId } });
      const cost = variant.supplierCost;
      await sendOrEditAdmin(chatId, messageId,
        `✏️ *Set Harga Custom - ${product.name}${variant.label ? ' - ' + variant.label : ''}*\n\n` +
        `${typeof cost === 'number' ? `Modal Supplier: ${usd(cost)}\n` : ''}Harga jual saat ini: ${usd(db.getBasePrice(variant))}\n\n` +
        `Ketik harga baru dalam USD (angka saja, boleh desimal, contoh: \`5\` atau \`5.99\`). Ketik /cancel untuk batal.`,
        supplierBackKeyboard()
      );
    }
    // Atur markup 3-tier (1-49/50-499/500+) KHUSUS 1 varian ini - override
    // DEFAULT_SUPPLIER_TIER_MARKUP global di config.js. Sekali diset, tiap
    // sync berikutnya (auto tiap SUPPLIER_SYNC_INTERVAL_MINUTES atau refresh
    // manual) akan pakai markup INI buat hitung ulang tier dari modal live -
    // jadi harga tetap "ikut" modal Supplier, tapi persentase untungnya
    // sesuai yang admin mau untuk produk ini secara spesifik (mis. Gemini
    // yang marginnya lebih tipis dari produk lain).
    // Tombol ini muncul di 2 tempat: (1) langsung setelah admin buka "💲
    // Harga" 1 varian tertentu (lewat pendingAction ctx 'supplier_link_price_ctx',
    // lihat di bawah), DAN (2) standalone lewat "📊 Atur Markup 3-Tier" di
    // menu utama Supplier API (lihat handler 'suppliertiermarkuppick' dst -
    // alurnya sama seperti "🎁 Set Tier Diskon Grosir": pilih produk -> pilih
    // varian -> ketik). Keduanya berakhir memanggil askSetTierMarkup() yang
    // sama, supaya tampilan & pending action-nya konsisten di 2 alur itu.
    else if (action === 'suppliertiermarkup') {
      const priceCtx = db.getPendingAction(chatId);
      if (!priceCtx || priceCtx.type !== 'supplier_link_price_ctx') {
        return bot.answerCallbackQuery(query.id, { text: '⚠️ Sesi sudah kadaluarsa, ulangi lagi dari Supplier API.', show_alert: true });
      }
      const { productId, variantId } = priceCtx.data;
      const product = db.findProduct(productId);
      const variant = product && product.variants.find(v => v.id === variantId);
      if (!product || !variant) return bot.answerCallbackQuery(query.id, { text: 'Varian tidak ditemukan.' });
      askSetTierMarkup(chatId, messageId, product, variant);
    }
    // Entry point standalone (dari menu utama Supplier API) - lihat catatan
    // di atas. Cuma tawarkan produk/varian yang MEMANG terhubung Supplier
    // API, karena markup% ini dihitung dari modal live Supplier - kalau
    // dipakai di varian manual, tidak ada modal buat dihitung.
    else if (action === 'suppliertiermarkuppick') {
      const linked = db.getSupplierLinkedVariants();
      if (!linked.length) {
        return sendOrEditAdmin(chatId, messageId, '📊 *Atur Markup 3-Tier*\n\nBelum ada varian yang terhubung ke Supplier API. Hubungkan dulu lewat "➕ Hubungkan Produk".', supplierBackKeyboard());
      }
      const seenIds = new Set();
      const linkedProducts = [];
      linked.forEach(l => {
        if (!seenIds.has(l.productId)) {
          seenIds.add(l.productId);
          const p = db.findProduct(l.productId);
          if (p) linkedProducts.push(p);
        }
      });
      if (linkedProducts.length === 1 && linkedProducts[0].variants.filter(v => v.supplierServiceId).length === 1) {
        const product = linkedProducts[0];
        const variant = product.variants.find(v => v.supplierServiceId);
        return askSetTierMarkup(chatId, messageId, product, variant);
      }
      await sendOrEditAdmin(chatId, messageId, '📊 *Atur Markup 3-Tier*\n\nPilih produk yang mau diatur (khusus varian yang terhubung Supplier API):', adminProductPickKeyboard('suppliertiermarkuppick_pick', linkedProducts));
    }
    else if (action === 'suppliertiermarkuppick_pick') {
      const product = db.findProduct(param);
      const linkedVariants = product ? product.variants.filter(v => v.supplierServiceId) : [];
      if (!product || !linkedVariants.length) {
        return sendOrEditAdmin(chatId, messageId, `⚠️ Produk *${product ? product.name : param}* tidak punya varian yang terhubung Supplier API.`, supplierBackKeyboard());
      }
      if (linkedVariants.length === 1) {
        return askSetTierMarkup(chatId, messageId, product, linkedVariants[0]);
      }
      await sendOrEditAdmin(chatId, messageId, `📊 Atur markup tier untuk *${product.name}*\n\nPilih varian (Supplier API):`, adminSupplierVariantPickKeyboard(product, 'suppliertiermarkuppick_variant', 'admin:suppliertiermarkuppick'));
    }
    else if (action === 'suppliertiermarkuppick_variant') {
      const product = db.findProduct(param);
      const variant = product && product.variants[Number(parts[3])];
      if (!product || !variant || !variant.supplierServiceId) return bot.answerCallbackQuery(query.id, { text: 'Varian tidak ditemukan / belum terhubung Supplier API.' });
      askSetTierMarkup(chatId, messageId, product, variant);
    }
    else if (action === 'supplierorderid') {
      db.setPendingAction(chatId, { type: 'supplier_orderid_lookup' });
      await sendOrEditAdmin(chatId, messageId,
        '🔍 *Cek Order ID (Supplier)*\n\nKetik Order ID yang mau dicek (contoh: `TRXN12345`). Ini order ID DI SISI Supplier, bukan Order ID lokal bot ini. Ketik /cancel untuk batal.',
        supplierBackKeyboard()
      );
    }
    else if (action === 'supplierharga') {
      const linked = db.getSupplierLinkedVariants();
      const l = linked[Number(param)];
      if (!l) return bot.answerCallbackQuery(query.id, { text: 'Varian tidak ditemukan.' });
      const { productId, variant, productName } = l;
      const cost = variant.supplierCost;
      const currentSellPrice = db.getBasePrice(variant);
      await sendOrEditAdmin(chatId, messageId,
        `💲 *Atur Harga - ${productName}${variant.label ? ' - ' + variant.label : ''}*\n\n${marginText(cost, currentSellPrice)}\n\nPilih markup cepat dari modal, atau isi harga custom.`,
        supplierLinkPriceKeyboard(chatId, productId, variant.id)
      );
    }
    else if (action === 'supplierunlinkconfirm') {
      const linkedIdx = Number(param);
      const linked = db.getSupplierLinkedVariants();
      const l = linked[linkedIdx];
      if (!l) return bot.answerCallbackQuery(query.id, { text: 'Varian tidak ditemukan.' });
      const { variant, productName } = l;
      const label = `${productName}${variant.label ? ' - ' + variant.label : ''}`;
      await sendOrEditAdmin(chatId, messageId,
        `⚠️ Yakin mau putuskan *${label}* dari Supplier API?\n\nVarian ini akan balik pakai stok lokal/manual - pastikan sudah ada stok yang diisi lewat 📥 Tambah Stock kalau mau tetap auto-kirim ke buyer.`,
        {
          inline_keyboard: [
            [{ text: '✅ Ya, Putuskan', callback_data: `admin:supplierunlink:${linkedIdx}` }],
            [{ text: '❌ Cancel', callback_data: 'admin:supplier' }]
          ]
        }
      );
    }
    else if (action === 'supplierunlink') {
      const linked = db.getSupplierLinkedVariants();
      const l = linked[Number(param)];
      if (!l) return bot.answerCallbackQuery(query.id, { text: 'Varian tidak ditemukan.' });
      db.clearVariantSupplier(l.productId, l.variant.id);
      await bot.answerCallbackQuery(query.id, { text: 'Link supplier diputus, varian ini balik pakai stok lokal.' }).catch(() => {});
      await sendOrEditAdmin(chatId, messageId, await supplierMenuText(), await supplierMenuKeyboard());
    }
    else if (action === 'supplierrefresh') {
      if (!AIVERSEHUB_API_KEY) {
        return sendOrEditAdmin(chatId, messageId, '⚠️ *AIVERSEHUB_API_KEY* belum diisi di `.env`.', supplierBackKeyboard());
      }
      const linkedCheck = db.getSupplierLinkedVariants();
      if (!linkedCheck.length) {
        return sendOrEditAdmin(chatId, messageId, '_Belum ada varian yang terhubung, tidak ada yang perlu di-refresh._', supplierBackKeyboard());
      }
      let updated, missing, invalidPrice, lines;
      try {
        ({ updated, missing, invalidPrice, lines } = await refreshSupplierData());
      } catch (err) {
        return sendOrEditAdmin(chatId, messageId, `⚠️ Gagal ambil data terbaru dari Supplier:\n_${err.message}_`, supplierBackKeyboard());
      }
      const problemTag = [missing ? `${missing} link rusak` : null, invalidPrice ? `${invalidPrice} modal tidak valid` : null].filter(Boolean).join(', ');
      await sendOrEditAdmin(chatId, messageId,
        `🔄 *Refresh Modal & Stok selesai*\n\n${updated} varian diperbarui${problemTag ? `, ${problemTag}` : ''}.\n\n${lines.join('\n\n')}`,
        supplierBackKeyboard()
      );
    }
    else if (action === 'supplierorders') {
      const page = Math.max(1, parseInt(param, 10) || 1);
      const { text, totalPages, page: actualPage } = await supplierOrdersText(page);
      await sendOrEditAdmin(chatId, messageId, text, supplierOrdersKeyboard(actualPage || page, totalPages));
    }
    else if (action === 'supplierstats') {
      await sendOrEditAdmin(chatId, messageId, await supplierStatsText(), supplierBackKeyboard());
    }

    // ===== Canboso API (supplier kedua) =====
    else if (action === 'canboso') {
      db.clearPendingAction(chatId);
      await sendOrEditAdmin(chatId, messageId, canbosoMenuText(), canbosoMenuKeyboard());
    }
    else if (action === 'canbosolink') {
      const productsWithVariants = db.getAllProducts().filter(p => p.variants.length > 0);
      if (!productsWithVariants.length) {
        await sendOrEditAdmin(chatId, messageId, '*Hubungkan Produk ke Canboso API*\n\nBelum ada produk dengan varian. Tambah varian dulu lewat ➕ Tambah Varian.', canbosoBackKeyboard());
      } else {
        await sendOrEditAdmin(chatId, messageId, '*Hubungkan Produk ke Canboso API*\n\nPilih produk lokal yang mau dihubungkan:', adminProductPickKeyboard('canbosolink_pick', productsWithVariants));
      }
    }
    else if (action === 'canbosolink_pick') {
      const product = db.findProduct(param);
      if (!product || !product.variants.length) {
        return sendOrEditAdmin(chatId, messageId, `⚠️ Produk *${product ? product.name : param}* belum punya varian.`, canbosoBackKeyboard());
      }
      if (product.variants.length === 1) {
        await showCanbosoProductPicker(chatId, messageId, param, product.variants[0].id);
      } else {
        await sendOrEditAdmin(chatId, messageId, `Hubungkan varian mana dari *${product.name}*?`, adminVariantPickKeyboard(product, 'canbosolink_variant', 'admin:canbosolink'));
      }
    }
    else if (action === 'canbosolink_variant') {
      const product = db.findProduct(param);
      const variant = product && product.variants[Number(parts[3])];
      if (!product || !variant) return bot.answerCallbackQuery(query.id, { text: 'Varian tidak ditemukan.' });
      await showCanbosoProductPicker(chatId, messageId, param, variant.id);
    }
    else if (action === 'canbosolink_set') {
      const idx = Number(param);
      const pending = db.getPendingAction(chatId);
      if (!pending || pending.type !== 'canboso_link_pick' || !pending.data.products[idx]) {
        return bot.answerCallbackQuery(query.id, { text: '⚠️ Sesi pilih produk sudah kadaluarsa, ulangi lagi dari Canboso API.', show_alert: true });
      }
      const { productId, variantId, products } = pending.data;
      const remote = products[idx];
      const product = db.findProduct(productId);
      const variant = product && product.variants.find(v => v.id === variantId);
      db.clearPendingAction(chatId);
      if (!product || !variant) {
        return sendOrEditAdmin(chatId, messageId, '⚠️ Produk/varian tidak ditemukan lagi, dibatalkan.', canbosoBackKeyboard());
      }
      const cost = typeof remote.price === 'number' ? remote.price : parseFloat(remote.price);
      db.setVariantCanboso(productId, variantId, remote.id, cost);
      const liveStockOnLink = Number(remote.stock);
      if (!isNaN(liveStockOnLink)) db.setVariantStock(productId, variantId, liveStockOnLink);
      const currentSellPrice = db.getBasePrice(variant);
      await sendOrEditAdmin(chatId, messageId,
        `✅ *${product.name}${variant.label ? ' - ' + variant.label : ''}* berhasil dihubungkan ke Canboso API!\n\n` +
        `Product ID: \`${remote.id}\`\n🌐 Nama di Canboso: ${remote.name || '-'}\n\n` +
        `Mulai sekarang, tiap ada buyer beli varian ini, bot akan otomatis pesan lewat Canboso dan langsung teruskan hasilnya ke buyer - stok lokal/manual varian ini (kalau ada) tetap dipakai LEBIH DULU, baru sisa kekurangannya dipesan otomatis ke Canboso.\n\n` +
        `${marginText(cost, currentSellPrice)}\n\n` +
        `Mau atur harga jual sekarang? Pilih markup cepat dari modal (${typeof cost === 'number' && !isNaN(cost) ? usd(cost) : '?'}), atau isi harga custom - atau langsung "Selesai" kalau harga jual sekarang sudah pas.`,
        canbosoLinkPriceKeyboard(chatId, productId, variantId)
      );
    }
    else if (action === 'canbosolinkmarkup') {
      const pct = Number(param);
      const priceCtx = db.getPendingAction(chatId);
      if (!priceCtx || priceCtx.type !== 'canboso_link_price_ctx') {
        return bot.answerCallbackQuery(query.id, { text: '⚠️ Sesi sudah kadaluarsa, ulangi lagi dari Canboso API.', show_alert: true });
      }
      const { productId, variantId } = priceCtx.data;
      const product = db.findProduct(productId);
      const variant = product && product.variants.find(v => v.id === variantId);
      if (!product || !variant) return bot.answerCallbackQuery(query.id, { text: 'Varian tidak ditemukan.' });
      const cost = variant.canbosoCost;
      if (typeof cost !== 'number' || isNaN(cost)) {
        return bot.answerCallbackQuery(query.id, { text: '⚠️ Harga modal tidak diketahui untuk varian ini - pakai ✏️ Harga Custom saja.', show_alert: true });
      }
      const newPrice = Math.round(cost * (1 + pct / 100) * 100) / 100;
      db.setVariantPrice(productId, variantId, newPrice);
      await bot.answerCallbackQuery(query.id, { text: `✅ Harga jual di-set ${usd(newPrice)} (modal +${pct}%)` }).catch(() => {});
      await sendOrEditAdmin(chatId, messageId,
        `✅ Harga jual *${product.name}${variant.label ? ' - ' + variant.label : ''}* di-set ke ${usd(newPrice)}.\n\n${marginText(cost, newPrice)}`,
        canbosoLinkPriceKeyboard(chatId, productId, variantId)
      );
    }
    else if (action === 'canbosolinkcustomprice') {
      const priceCtx = db.getPendingAction(chatId);
      if (!priceCtx || priceCtx.type !== 'canboso_link_price_ctx') {
        return bot.answerCallbackQuery(query.id, { text: '⚠️ Sesi sudah kadaluarsa, ulangi lagi dari Canboso API.', show_alert: true });
      }
      const { productId, variantId } = priceCtx.data;
      const product = db.findProduct(productId);
      const variant = product && product.variants.find(v => v.id === variantId);
      if (!product || !variant) return bot.answerCallbackQuery(query.id, { text: 'Varian tidak ditemukan.' });
      db.setPendingAction(chatId, { type: 'setprice_amount', data: { productId, variantId } });
      const cost = variant.canbosoCost;
      await sendOrEditAdmin(chatId, messageId,
        `✏️ *Set Harga Custom - ${product.name}${variant.label ? ' - ' + variant.label : ''}*\n\n` +
        `${typeof cost === 'number' ? `Modal Canboso: ${usd(cost)}\n` : ''}Harga jual saat ini: ${usd(db.getBasePrice(variant))}\n\n` +
        `Ketik harga baru dalam USD (angka saja, boleh desimal, contoh: \`5\` atau \`5.99\`). Ketik /cancel untuk batal.`,
        canbosoBackKeyboard()
      );
    }
    else if (action === 'canbosoharga') {
      const linked = db.getCanbosoLinkedVariants();
      const l = linked[Number(param)];
      if (!l) return bot.answerCallbackQuery(query.id, { text: 'Varian tidak ditemukan.' });
      const { productId, variant, productName } = l;
      const cost = variant.canbosoCost;
      const currentSellPrice = db.getBasePrice(variant);
      await sendOrEditAdmin(chatId, messageId,
        `💲 *Atur Harga - ${productName}${variant.label ? ' - ' + variant.label : ''}*\n\n${marginText(cost, currentSellPrice)}\n\nPilih markup cepat dari modal, atau isi harga custom.`,
        canbosoLinkPriceKeyboard(chatId, productId, variant.id)
      );
    }
    else if (action === 'canbosounlinkconfirm') {
      const linkedIdx = Number(param);
      const linked = db.getCanbosoLinkedVariants();
      const l = linked[linkedIdx];
      if (!l) return bot.answerCallbackQuery(query.id, { text: 'Varian tidak ditemukan.' });
      const { variant, productName } = l;
      const label = `${productName}${variant.label ? ' - ' + variant.label : ''}`;
      await sendOrEditAdmin(chatId, messageId,
        `⚠️ Yakin mau putuskan *${label}* dari Canboso API?\n\nVarian ini akan balik pakai stok lokal/manual - pastikan sudah ada stok yang diisi lewat 📥 Tambah Stock kalau mau tetap auto-kirim ke buyer.`,
        {
          inline_keyboard: [
            [{ text: '✅ Ya, Putuskan', callback_data: `admin:canbosounlink:${linkedIdx}` }],
            [{ text: '❌ Cancel', callback_data: 'admin:canboso' }]
          ]
        }
      );
    }
    else if (action === 'canbosounlink') {
      const linked = db.getCanbosoLinkedVariants();
      const l = linked[Number(param)];
      if (!l) return bot.answerCallbackQuery(query.id, { text: 'Varian tidak ditemukan.' });
      db.clearVariantCanboso(l.productId, l.variant.id);
      await bot.answerCallbackQuery(query.id, { text: 'Link Canboso diputus, varian ini balik pakai stok lokal.' }).catch(() => {});
      await sendOrEditAdmin(chatId, messageId, canbosoMenuText(), canbosoMenuKeyboard());
    }
    else if (action === 'canbosodebug') {
      if (!CANBOSO_API_KEY) {
        return bot.answerCallbackQuery(query.id, { text: 'CANBOSO_API_KEY belum diisi di .env.', show_alert: true });
      }
      let raw;
      try {
        raw = await canboso.getRawProducts();
      } catch (err) {
        return bot.answerCallbackQuery(query.id, { text: `Gagal ambil raw response: ${err.message}`, show_alert: true }).catch(() => {});
      }
      // Telegram batas 4096 karakter per pesan - potong kalau kepanjangan,
      // dan kirim sebagai pesan BARU (bukan edit) supaya gampang di-scroll/
      // di-forward/copy-paste ke developer buat sesuaikan pemetaan field
      // di getProducts() (supplierCanboso.js).
      let text = JSON.stringify(raw, null, 2);
      const truncated = text.length > 3500;
      if (truncated) text = text.slice(0, 3500) + '\n... (dipotong, total ' + text.length + ' karakter)';
      await bot.sendMessage(chatId, `🐞 <b>Raw Response Canboso</b> (<code>GET /api/v2/telegram-buyer/products</code>)\n\n<pre>${escapeHtml(text)}</pre>`, { parse_mode: 'HTML' }).catch(async () => {
        await bot.sendMessage(chatId, '⚠️ Gagal kirim raw response (mungkin format HTML-nya bentrok) - coba lagi.');
      });
      await bot.answerCallbackQuery(query.id).catch(() => {});
    }
    else if (action === 'canbosorefresh') {
      if (!CANBOSO_API_KEY) {
        return sendOrEditAdmin(chatId, messageId, '⚠️ *CANBOSO_API_KEY* belum diisi di `.env`.', canbosoBackKeyboard());
      }
      const linkedCheck = db.getCanbosoLinkedVariants();
      if (!linkedCheck.length) {
        return sendOrEditAdmin(chatId, messageId, '_Belum ada varian yang terhubung, tidak ada yang perlu di-refresh._', canbosoBackKeyboard());
      }
      let updated, missing, lines;
      try {
        ({ updated, missing, lines } = await refreshCanbosoData());
      } catch (err) {
        return sendOrEditAdmin(chatId, messageId, `⚠️ Gagal ambil data terbaru dari Canboso:\n_${err.message}_`, canbosoBackKeyboard());
      }
      await sendOrEditAdmin(chatId, messageId,
        `🔄 *Refresh Harga & Stok selesai*\n\n${updated} varian diperbarui${missing ? `, ${missing} link rusak` : ''}.\n\n${lines.join('\n\n')}`,
        canbosoBackKeyboard()
      );
    }

    else if (action === 'removeproduct') {
      await sendOrEditAdmin(chatId, messageId, '🗑️ *Hapus Produk*\n\nPilih produk yang ingin dihapus:', adminProductPickKeyboard('rmpick'));
    }
    else if (action === 'rmpick') {
      const product = db.findProduct(param);
      if (!product) return bot.answerCallbackQuery(query.id, { text: 'Produk tidak ditemukan.' });
      await sendOrEditAdmin(chatId, messageId,
        `⚠️ Yakin hapus produk *${product.name}* (id: \`${product.id}\`) beserta semua variannya?`,
        { inline_keyboard: [
          [{ text: '✅ Ya, Hapus', callback_data: `admin:rmconfirm:${param}` }],
          [{ text: '‹ Batal', callback_data: 'admin:removeproduct' }]
        ] }
      );
    }
    else if (action === 'rmconfirm') {
      const ok = db.removeProduct(param);
      await sendOrEditAdmin(chatId, messageId,
        ok ? `✅ Produk \`${param}\` berhasil dihapus.` : `⚠️ Produk \`${param}\` tidak ditemukan.`,
        adminBackKeyboard('admin:cat_products')
      );
    }

    else if (action === 'addbalance') {
      db.setPendingAction(chatId, { type: 'addbalance_user' });
      await sendOrEditAdmin(chatId, messageId, '💰 *Atur Saldo User*\n\nKetik chat ID user yang ingin diubah saldonya:', adminBackKeyboard('admin:cat_users'));
    }

    else if (action === 'deliverylog') {
      const logs = db.getDeliveryLogs(10);
      if (!logs.length) {
        await sendOrEditAdmin(chatId, messageId, '📜 *Log Pengiriman Otomatis*\n\nBelum ada order yang auto-delivered.', adminBackKeyboard('admin:cat_reports'));
      } else {
        await sendOrEditAdmin(chatId, messageId, `📜 *Log Pengiriman Otomatis* (${logs.length} terakhir)`, adminBackKeyboard('admin:cat_reports'));
        for (const order of logs) {
          await bot.sendMessage(chatId, formatDeliveryLogEntry(order), { parse_mode: 'HTML' }).catch(() => {});
        }
      }
    }

    else if (action === 'checkorder') {
      db.setPendingAction(chatId, { type: 'checkorder_id' });
      await sendOrEditAdmin(chatId, messageId, '🔍 *Cek Order ID*\n\nKetik ID order yang mau dicek (contoh: `ord_1735500000000`).\n\nID bisa dilihat di notifikasi order baru atau riwayat pembelian user.', adminBackKeyboard('admin:cat_reports'));
    }

    else if (action === 'emojiids') {
      db.clearPendingAction(chatId);
      await sendOrEditAdmin(chatId, messageId,
        '🎨 *Kelola Emoji ID*\n\nPilih kategori tombol/teks yang mau dipasangi emoji premium. Nanti tinggal kirim/forward 1 pesan berisi emoji-nya - ID-nya ke-*capture otomatis*, gak perlu lewat @RawDataBot lagi.',
        adminEmojiCategoryKeyboard()
      );
    }

    else if (action === 'emojicat') {
      const catId = param;
      const catLabel = (EMOJI_CATEGORIES.find(c => c.id === catId) || {}).label || catId;
      await sendOrEditAdmin(chatId, messageId,
        `🎨 *${catLabel}*\n\n✅ = sudah ada ID custom\n⚪ = masih default/kosong\n\nTap salah satu buat pasang/ganti emoji-nya.`,
        adminEmojiKeyListKeyboard(catId)
      );
    }

    else if (action === 'emojiteks') {
      await sendOrEditAdmin(chatId, messageId,
        '✍️ *Emoji di Teks Pesan*\n\nPilih halaman/grup pesannya dulu:',
        adminEmojiTeksGroupKeyboard()
      );
    }

    else if (action === 'emojiteksgroup') {
      const groupId = param;
      const groupLabel = (TEKS_GROUPS.find(g => g.id === groupId) || {}).label || groupId;
      await sendOrEditAdmin(chatId, messageId,
        `🎨 *${groupLabel}*\n\n✅ = sudah ada ID custom\n⚪ = masih default/kosong\n\nTap salah satu buat pasang/ganti emoji-nya.`,
        adminEmojiTeksItemKeyboard(groupId)
      );
    }

    else if (action === 'emojiset') {
      const scope = parts[2];
      const key = parts[3];
      if (!scope || !key) return;
      db.setPendingAction(chatId, { type: 'set_emoji_id', data: { scope, key } });
      let label = scope === 'teks' ? findTeksItemLabel(key) : (EMOJI_KEY_LABELS[key] || key);
      // Scope "gift" -> key-nya giftId (bukan label statis di EMOJI_KEY_LABELS),
      // jadi cari label yang lebih enak dibaca (nominal stars-nya) dari katalog
      // live - lihat adminGiftEmojiListKeyboard().
      if (scope === 'gift') {
        try {
          const catalog = await userbot.getGiftCatalog();
          const g = catalog.find(x => x.id === key);
          if (g) label = `🎁 Gift ${g.stars}⭐ (id: ${g.id})`;
        } catch (err) {
          logError('emojiset gift label lookup', err);
        }
      }
      const current = db.getEmojiId(`${scope}:${key}`);
      await sendOrEditAdmin(chatId, messageId,
        `🎨 *Set Emoji: ${label}*\n\n` +
        `Kirim (boleh forward dari chat lain) 1 pesan yang mengandung *emoji premium* (dipilih dari panel emoji Telegram Premium, bukan cuma ngetik unicode biasa) yang mau dipasang di sini.\n\n` +
        (current ? `ℹ️ Saat ini sudah terisi ID: \`${current}\`\n\n` : '') +
        `Ketik /cancel untuk batal, atau /hapusemoji buat kosongkan lagi (balik ke default).`,
        adminBackKeyboard(scope === 'gift' ? 'admin:giftemoji' : 'admin:cat_settings')
      );
    }

    else if (action === 'stats') {
      const allDb = db.readDb();
      const users = Object.values(allDb.users);
      const totalUsers = users.length;
      const totalBalance = users.reduce((sum, u) => sum + (u.balance || 0), 0);
      const totalOrders = allDb.orders.length;
      const totalRevenue = allDb.orders.reduce((sum, o) => sum + (o.total || 0), 0);
      const pendingDepositCount = allDb.deposits.filter(d => d.status === 'pending').length;
      const text =
        `📊 *Statistik Toko*\n\n` +
        `👤 Total user: *${totalUsers}*\n` +
        `💰 Total saldo beredar: *${usd(totalBalance)}*\n` +
        `🧾 Total order: *${totalOrders}*\n` +
        `💵 Total omzet: *${usd(totalRevenue)}*\n` +
        `⏳ Topup pending (menunggu pembayaran): *${pendingDepositCount}*`;
      await sendOrEditAdmin(chatId, messageId, text, adminBackKeyboard('admin:cat_reports'));
    }

    else if (action === 'listusers') {
      const page = Math.max(1, parseInt(param, 10) || 1);
      const { text, totalPages, page: actualPage } = usersListText(page);
      await sendOrEditAdmin(chatId, messageId, text, usersListKeyboard(actualPage || page, totalPages), 'HTML');
    }

    else if (action === 'listusers_search') {
      db.setPendingAction(chatId, { type: 'listusers_search_id' });
      await sendOrEditAdmin(chatId, messageId,
        '🔍 <b>Cari User berdasarkan ID/Username</b>\n\nKetik Chat ID (boleh lengkap atau cuma sebagian angkanya, mis. <code>6213878</code>) ATAU ketik username-nya (boleh pakai "@" atau tidak, mis. <code>@nnamzcs</code> atau <code>nnamzcs</code>) - bot otomatis deteksi mana yang kamu ketik.\n\nKetik /cancel untuk batal.',
        { inline_keyboard: [[{ text: '‹ Kembali ke List User', callback_data: 'admin:listusers:1' }]] },
        'HTML'
      );
    }

    else if (action === 'maintenance') {
      db.clearPendingAction(chatId);
      const settings = db.getMaintenanceSettings();
      await sendOrEditAdmin(chatId, messageId, maintenanceMenuText(settings), maintenanceMenuKeyboard(settings));
    }

    // Toggle Mode Maintenance - kedua arah transisinya sekarang sama-sama
    // proaktif ngasih tau: broadcast ke SEMUA user terdaftar (sama alur
    // kirim seperti 📢 Broadcast - lihat action 'broadcast' sub 'send' di
    // bawah) SEKALIGUS kirim notifikasi ke channel/group (kalau fitur 📣
    // Notifikasi Channel aktif & notifyMaintenance dinyalakan - lihat
    // sendChannelNotif()/buildChannelMaintenanceText()), supaya user maupun
    // member channel tidak perlu nebak-nebak status bot:
    // - AKTIF -> NONAKTIF ("🔴 Nonaktifkan"): broadcast teks "Maintenance
    //   SELESAI" (buildMaintenanceFinishedText) + notif channel status finish.
    // - NONAKTIF -> AKTIF ("🟢 Aktifkan"): broadcast teks maintenance yang
    //   SAMA persis dengan yang bakal dilihat user kalau mereka coba
    //   interaksi (buildMaintenanceText - custom message admin kalau ada,
    //   atau default) + notif channel status start.
    else if (action === 'maintenance_toggle') {
      const current = db.getMaintenanceSettings();
      const turningOn = current.enabled === false;
      const turningOff = current.enabled === true;
      const settings = db.setMaintenanceSettings({ enabled: !current.enabled });
      await sendOrEditAdmin(chatId, messageId, maintenanceMenuText(settings), maintenanceMenuKeyboard(settings));
      await bot.answerCallbackQuery(query.id, {
        text: settings.enabled
          ? '🟢 Mode Maintenance diaktifkan, sedang broadcast ke semua user...'
          : '🔴 Mode Maintenance dinonaktifkan, sedang broadcast ke semua user...'
      }).catch(() => {});

      // Notifikasi channel/group - dikirim SEKALI, bukan per-user, jadi
      // aman ditembak duluan sebelum loop broadcast user (yang bisa makan
      // waktu kalau user-nya banyak).
      sendChannelNotif('maintenance', buildChannelMaintenanceText(turningOn ? 'start' : 'finish'));

      if (turningOn || turningOff) {
        const allDb = db.readDb();
        const userIds = Object.keys(allDb.users);
        let success = 0, failed = 0;
        for (const uid of userIds) {
          try {
            const text = turningOn ? buildMaintenanceText(uid) : buildMaintenanceFinishedText(uid);
            await bot.sendMessage(uid, text, { parse_mode: 'HTML' });
            success++;
          } catch (err) {
            failed++; // biasanya karena user sudah blokir/hapus bot - lanjut ke user berikutnya
          }
          // Jeda kecil antar pesan supaya tidak kena rate limit Telegram (sama seperti 📢 Broadcast).
          await new Promise(r => setTimeout(r, 40));
        }
        const label = turningOn ? 'Maintenance Dimulai' : 'Maintenance Selesai';
        await bot.sendMessage(chatId,
          `📤 *Broadcast "${label}" terkirim.*\n\n📨 Berhasil: *${success}*\n⚠️ Gagal (kemungkinan user sudah blokir bot): *${failed}*`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      }
    }

    else if (action === 'maintenance_preview') {
      await bot.sendMessage(chatId, buildMaintenanceText(chatId), { parse_mode: 'HTML' }).catch(() => {});
      await bot.answerCallbackQuery(query.id).catch(() => {});
    }

    else if (action === 'maintenance_setmsg') {
      db.setPendingAction(chatId, { type: 'maintenance_message' });
      await sendOrEditAdmin(chatId, messageId,
        '✏️ *Set Pesan Custom Maintenance*\n\nKetik pesan yang mau ditampilkan ke user non-admin selama Mode Maintenance aktif - bebas, boleh banyak baris, boleh tag HTML `<b>...</b>`, dan kalau kamu pilih *emoji premium* langsung dari panel emoji Telegram Premium-mu, emoji itu otomatis ikut kesimpan sebagai premium juga.\n\nKetik /cancel untuk batal.',
        adminBackKeyboard('admin:cat_settings')
      );
    }

    else if (action === 'maintenance_resetmsg') {
      const settings = db.setMaintenanceSettings({ message: null });
      await sendOrEditAdmin(chatId, messageId, maintenanceMenuText(settings), maintenanceMenuKeyboard(settings));
      await bot.answerCallbackQuery(query.id, { text: '↩️ Balik pakai pesan default.' }).catch(() => {});
    }

    else if (action === 'backup') {
      const sub = param; // undefined = tampilkan menu, atau 'toggle'/'setinterval'/'setgroup'/'now'

      if (!sub) {
        db.clearPendingAction(chatId);
        const settings = db.getBackupSettings();
        await sendOrEditAdmin(chatId, messageId, backupMenuText(settings), backupMenuKeyboard(settings));
      }

      else if (sub === 'toggle') {
        const current = db.getBackupSettings();
        if (!current.enabled && !current.groupId) {
          return bot.answerCallbackQuery(query.id, { text: '⚠️ Isi dulu Group ID tujuan sebelum mengaktifkan.', show_alert: true });
        }
        const settings = db.setBackupSettings({ enabled: !current.enabled });
        scheduleBackup();
        await sendOrEditAdmin(chatId, messageId, backupMenuText(settings), backupMenuKeyboard(settings));
      }

      else if (sub === 'setinterval') {
        db.setPendingAction(chatId, { type: 'backup_interval' });
        await sendOrEditAdmin(chatId, messageId,
          '⏱️ *Atur Interval Backup*\n\nKetik interval backup dalam *MENIT* (angka saja).\n\nContoh: `60` untuk tiap jam, `15` untuk tiap 15 menit, `1440` untuk tiap hari. Minimal `1`.\n\nKetik /cancel untuk batal.',
          adminBackKeyboard('admin:cat_settings')
        );
      }

      else if (sub === 'setgroup') {
        db.setPendingAction(chatId, { type: 'backup_groupid' });
        await sendOrEditAdmin(chatId, messageId,
          '🆔 *Atur Group ID Tujuan*\n\nKetik Group ID Telegram tujuan (angka, group/supergroup biasanya diawali minus, contoh: `-1001234567890`).\n\n' +
          'Cara dapat Group ID: tambahkan bot ini ke group tujuan, lalu forward pesan apapun dari group itu ke @userinfobot atau @RawDataBot untuk melihat ID-nya.\n\n' +
          '⚠️ Bot wajib sudah jadi member di group tersebut, kalau tidak pengiriman backup akan gagal.\n\nKetik /cancel untuk batal.',
          adminBackKeyboard('admin:cat_settings')
        );
      }

      else if (sub === 'now') {
        const settings = db.getBackupSettings();
        if (!settings.groupId) {
          return bot.answerCallbackQuery(query.id, { text: '⚠️ Isi dulu Group ID tujuan.', show_alert: true });
        }
        await bot.answerCallbackQuery(query.id, { text: '⏳ Membuat & mengirim backup...' });
        const result = await runBackupJob('manual');
        const followUpText = result.ok
          ? `✅ Backup berhasil dikirim ke group \`${settings.groupId}\` (${result.sizeKb} KB).`
          : `⚠️ Backup gagal: ${result.error}`;
        await bot.sendMessage(chatId, followUpText, { parse_mode: 'Markdown' }).catch(() => {});
        return; // sudah answerCallbackQuery manual di atas
      }
    }

    else if (action === 'broadcast') {
      const sub = param; // undefined = mulai broadcast baru, atau 'send'/'cancel'

      if (!sub) {
        db.clearPendingAction(chatId);
        db.setPendingAction(chatId, { type: 'broadcast_content' });
        const totalUsers = Object.keys(db.readDb().users).length;
        await sendOrEditAdmin(chatId, messageId,
          `📢 *Broadcast ke Semua User*\n\nTotal user saat ini: *${totalUsers}*\n\n` +
          `Kirim sekarang pesan yang mau di-broadcast:\n` +
          `• Ketik *teks* aja, atau\n` +
          `• Kirim *foto* (boleh + caption, boleh tanpa caption)\n\n` +
          `Teks/caption *bebas* — boleh banyak baris, boleh tag HTML (\`<b>bold</b>\`, \`<i>italic</i>\`, \`<u>underline</u>\`, \`<s>coret</s>\`, \`<a href="...">link</a>\`, \`<blockquote>kutipan</blockquote>\`, dll), dan kalau kamu pilih *emoji premium* langsung dari panel emoji Telegram Premium kamu sendiri, emoji itu otomatis kesimpan sebagai premium juga ke semua user penerima.\n\n` +
          `Setelah dikirim ke bot, kamu akan lihat *preview* dulu sebelum benar-benar di-broadcast.\n\nKetik /cancel untuk batal.`,
          adminBackKeyboard('admin:cat_settings')
        );
      }

      else if (sub === 'cancel') {
        db.clearPendingAction(chatId);
        await sendOrEditAdmin(chatId, messageId, '❌ Broadcast dibatalkan.', adminBackKeyboard('admin:cat_settings'));
      }

      else if (sub === 'send') {
        const pendingBroadcast = db.getPendingAction(chatId);
        if (!pendingBroadcast || pendingBroadcast.type !== 'broadcast_confirm') {
          return bot.answerCallbackQuery(query.id, { text: '⚠️ Tidak ada broadcast yang menunggu dikirim. Buat broadcast baru dulu.', show_alert: true });
        }
        const { content } = pendingBroadcast.data;
        db.clearPendingAction(chatId);
        await bot.answerCallbackQuery(query.id, { text: '📤 Mengirim broadcast...' });

        const allDb = db.readDb();
        const userIds = Object.keys(allDb.users);
        let success = 0, failed = 0;
        for (const uid of userIds) {
          try {
            if (content.kind === 'photo') {
              await bot.sendPhoto(uid, content.fileId, { caption: content.caption, parse_mode: 'HTML' });
            } else {
              await bot.sendMessage(uid, content.text, { parse_mode: 'HTML' });
            }
            success++;
          } catch (err) {
            failed++; // biasanya karena user sudah blokir/hapus bot - lanjut ke user berikutnya
          }
          // Jeda kecil antar pesan supaya tidak kena rate limit Telegram.
          await new Promise(r => setTimeout(r, 40));
        }

        await bot.sendMessage(chatId,
          `✅ *Broadcast selesai.*\n\n📨 Berhasil terkirim: *${success}*\n⚠️ Gagal (kemungkinan user sudah blokir bot): *${failed}*`,
          { parse_mode: 'Markdown' }
        );
        return; // sudah answerCallbackQuery manual di atas
      }
    }

    bot.answerCallbackQuery(query.id).catch(() => {});
  } catch (err) {
    logError('callback_query_broadcast', err);
    bot.answerCallbackQuery(query.id, { text: 'Terjadi kesalahan.' }).catch(() => {});
  }
});

resumePendingDeposits();

// Seed sekali dari .env kalau db.json belum pernah diisi settingan backup-nya
// - supaya bisa pre-configure BACKUP_GROUP_ID / BACKUP_INTERVAL_MINUTES di
// .env sebelum run pertama. Setelahnya, pengaturan selalu lewat /admin.
(function seedBackupSettingsFromEnv() {
  const current = db.getBackupSettings();
  const patch = {};
  if (!current.groupId && process.env.BACKUP_GROUP_ID) {
    patch.groupId = process.env.BACKUP_GROUP_ID.trim();
  }
  if (process.env.BACKUP_INTERVAL_MINUTES && current.intervalMinutes === 60) {
    const envMinutes = Number(process.env.BACKUP_INTERVAL_MINUTES);
    if (envMinutes > 0) patch.intervalMinutes = envMinutes;
  }
  if (Object.keys(patch).length) db.setBackupSettings(patch);
})();
scheduleBackup();
scheduleSupplierSync();
scheduleCanbosoSync();
scheduleProductListRepaint();

console.log('🤖 Bot berjalan...');
