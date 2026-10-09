const config = {
    APP_NAME: "Razor",
    JWT_SECRET: process.env.JWT_SECRET || "000-xxxxx-000",
    SESSION_SECRET: process.env.SESSION || "000-xxxxx-000",
    SCHEDULE_SECRET: process.env.SCHEDULE_SECRET || "",
    MONGODB_URI: process.env.MONGO_ATLAS_URI || "mongodb://localhost:27017",
    BCRYPT_SALT: process.env.BCRYPT_SALT || 10,
    role: {
        USER: ["user", "admin"],
        ADMIN: ["admin"]
    },
    URL: {
        LANDING_URL: process.env.LANDING_URL || "http://localhost:3000",
        DASHBOARD_URL: process.env.DASHBOARD_URL || "http://localhost:3000/app"
    }      
};

module.exports = config;
