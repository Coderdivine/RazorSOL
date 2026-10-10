require("express-async-errors");
const app = require("express")();
require("./v2/middlewares/pre-route.middleware")(app);
app.use(require("./v2/routes"));
require("./v2/middlewares/error.middleware")(app);
const PORT = process.env.PORT || 5001;
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

app.listen(PORT, async () => {
  require("./v2/database/mongo");
  console.log(`:::> Server listening on port ${PORT} http://localhost:${PORT}`);
  
  // Wait a brief moment for DB to connect before starting bots
  setTimeout(() => {
      telegramService.init();
      pumpPortalService.connect();
  }, 3000);
});

app.on("error", (error) => {
  console.error(`<::: An error occurred on the server: \n ${error}`);
});

module.exports = app;
