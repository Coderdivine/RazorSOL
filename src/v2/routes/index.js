const router = require("express").Router();

router.use("/v2/user", require("./user.route"));

router.get("/", (req, res) => {
    return res.status(200).json({ message: "Hello world from Razor Trading Bot API" });
});

module.exports = router;