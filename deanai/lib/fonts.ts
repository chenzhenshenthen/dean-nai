// Keep the local build genuinely offline. The upstream used next/font/google, which downloads
// three font families during every clean production build. System stacks in globals.css cover
// Latin and Chinese without a build-time network request.
export const fontVars = "fonts-local";
