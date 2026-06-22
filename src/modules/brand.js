// RaPiSys brand mark — the Eye of Horus (Wedjat) from the project reference logo,
// recolored to white strokes with a red pupil so it reads on the gradient .logo-icon
// tile. Shipped as a static raster asset (src/public/rapisys-eye.png) and referenced
// here so the header, nav rail, and welcome banner all use one source of truth.
export const EYE_SRC = '/rapisys-eye.png';

// Returns an <img> for the eye mark. `cls` is applied for sizing/placement.
export function eyeLogoImg(cls = 'logo-eye') {
  return `<img src="${EYE_SRC}" alt="RaPiSys" class="${cls}" draggable="false">`;
}
