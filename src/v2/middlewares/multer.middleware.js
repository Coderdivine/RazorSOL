const upload = require("../utils/multer");

async function addPathToBody(req, res, next) {
    console.log(req.file)
    console.log(req.files);
    if (req.files) {
        req.body["audio"] = req.files.map((file) => file.path.replace("\\", "/"));
    }

    if (req.file) {
        req.body["audio"] = req.file.path.replace("\\", "/");
    }

    next();
}

module.exports = (field) => {
    return [upload.single(field), addPathToBody];
};
