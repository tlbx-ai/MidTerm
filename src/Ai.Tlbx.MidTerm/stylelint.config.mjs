export default {
  rules: {
    'block-no-empty': true,
    'color-no-invalid-hex': true,
    'comment-no-empty': true,
    'declaration-block-no-duplicate-properties': [
      true,
      {
        ignore: ['consecutive-duplicates-with-different-values'],
      },
    ],
    'declaration-block-no-redundant-longhand-properties': true,
    'font-family-no-duplicate-names': true,
    'function-calc-no-unspaced-operator': true,
    'keyframe-block-no-duplicate-selectors': true,
    'no-duplicate-selectors': true,
    'property-no-unknown': [
      true,
      {
        ignoreProperties: ['leading-trim', 'text-edge'],
      },
    ],
    'selector-pseudo-class-no-unknown': true,
    'selector-pseudo-element-no-unknown': true,
    'shorthand-property-no-redundant-values': true,
    'unit-no-unknown': true,
  },
};
