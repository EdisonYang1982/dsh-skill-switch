/** CSS-modules build step: the loader returns a plain class-name map. */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
