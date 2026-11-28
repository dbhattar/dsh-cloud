// Browser half of dsh-cloud-brand, in the closure-factory form the harness serves (the same shape its own client bundles have).
// It is hand-written and has no build step. lib/client.js is generated from this file by scripts/render-branding.sh, which
// puts the icon in place of __ICON_DATA_URI__; edit this file, not the generated one.
window.__ModuleLoader__.load({
  id: `dsh-cloud-brand`,
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const ICON = '__ICON_DATA_URI__';
    function Mark({ size, className }) {
      return React.createElement('img', {
        src: ICON, width: size, height: size, alt: '', className, 'data-dsh-cloud-brand': '', draggable: false,
        style: { borderRadius: Math.round(size / 5), display: 'block' },
      });
    }
    const inject = ['slots'];
    function apply(ctx) {
      ctx.slots.inject('sidebar.brand.mark', () =>
        ctx.slots.inject('conversation.hero.brand.mark', function* () {
          yield ctx.slots.register({ name: 'sidebar.brand.mark' }, Mark);
          yield ctx.slots.register({ name: 'conversation.hero.brand.mark' }, Mark);
        }));
    }
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
  meta: () => ({}),
});
