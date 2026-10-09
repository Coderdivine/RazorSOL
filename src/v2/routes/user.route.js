require("dotenv").config();
const router = require("express").Router();
const auth = require("../middlewares/auth.middleware")();
const UserCtrl = require("../controllers/user.controller");

router.post("/register", UserCtrl.register);
router.post("/login", UserCtrl.login)

module.exports = router;