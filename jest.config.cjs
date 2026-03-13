module.exports = {
  testEnvironment: "node",
  testMatch: [
    "**/test/unit/**/*.jest.test.js",
    "**/test/integration/**/*.test.js",
  ],
  transform: {},
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
};
