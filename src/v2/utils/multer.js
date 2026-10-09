const multer = require("multer");
const CustomError = require("./custom-error");
const UniqueIDGenerator = require("./../utils/unique-id-generator");

const storage = multer.diskStorage({
    destination:'/tmp',
    filename: (req, file, cb) => {
        const fileExt = file.originalname.split(".").pop();
        const filename = `${new UniqueIDGenerator().generateRandom()}_${new Date().getTime()}.${fileExt}`;
        cb(null, filename);
    }
});

const limits = {
    // Maximum file size of 20mb
    fileSize: 20 * 1024 * 1024
};

const fileFilter = (req, file, cb) => {
    // Accepted file types
    const mimeTypes = ["audio/wav", "audio/x-wav", "audio/pcm"];
  
    // Check if the file type is accepted
    if (mimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new CustomError("Invalid file type. Only WAV and PCM files are allowed.", 400), false);
    }
  };
  
module.exports = multer({ storage, limits, fileFilter });
