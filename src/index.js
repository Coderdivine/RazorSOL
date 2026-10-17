require("express-async-errors");
const app = require("express")();
require("./v2/middlewares/pre-route.middleware")(app);
app.use(require("./v2/routes"));
require("./v2/middlewares/error.middleware")(app);
// Process-level safety handlers to prevent network glitches (ECONNRESET, ETIMEDOUT) from crashing the server
process.on('unhandledRejection', (reason) => {
  console.warn('[PROCESS] ⚠️ Handled Unhandled Rejection:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.warn('[PROCESS] ⚠️ Handled Uncaught Exception:', err?.message || err);
});

const PORT = process.env.PORT || 2059;
const cookieSession = require("cookie-session");
const rateLimit = require('express-rate-limit');
const useragent = require('express-useragent');
app.use(useragent.express());

// Services
const telegramService = require('./v2/services/telegram.service');
const pumpPortalService = require('./v2/services/pumpportal.service');

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.',
})

app.use(
  cookieSession({
    name: "session",
    keys:["cyberwolve"],
    maxAge: 24 * 60 * 60 * 100
  })
);

// Health check for Render
app.get('/health', (req, res) => {
    res.status(200).send("OK");
});

app.use("/", apiLimiter);

const server = app.listen(PORT, async () => {
  require("./v2/database/mongo");
  console.log(`:::> Server listening on port ${PORT} http://localhost:${PORT}`);
  
  // Wait a brief moment for DB to connect before starting bots
  setTimeout(async () => {
      const tradeEngine = require('./v2/services/trade-engine.service');
      await tradeEngine.loadSettings();
      telegramService.init();
      pumpPortalService.connect();
  }, 3000);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`\n[SERVER] 🚨 Error: Port ${PORT} is already in use by another running instance.`);
    console.error(`[SERVER] 💡 To free this port automatically, run: lsof -ti :${PORT} | xargs kill -9\n`);
    process.exit(1);
  } else {
    console.error(`<::: An error occurred on the server: \n`, error);
    process.exit(1);
  }
});

module.exports = app;
