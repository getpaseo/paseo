// Loaded by vitest in place of binary assets (PNG/JPG/SVG/etc.) imported
// from app source. The shape mimics what react-native's `require("./img.png")`
// returns: an object the `<Image source={...} />` component accepts.
const stub = { uri: "data:image/png;base64,", width: 0, height: 0 };
export default stub;
module.exports = stub;
