// Lints the site's blocks and stylesheets. pre.style's config comes last,
// so its syntax is the one used.
export default {
  extends: ['stylelint-config-standard-scss', '@pre.style/stylelint/config'],
};
