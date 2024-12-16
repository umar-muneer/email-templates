const fs = require('fs');
const path = require('path');

const I18N = require('@ladjs/i18n');
const _ = require('lodash');
const consolidate = require('consolidate');
const debug = require('debug')('email-templates');
const getPaths = require('get-paths');
const htmlToText = require('html-to-text');
const is = require('@sindresorhus/is');
const juice = require('juice');
const nodemailer = require('nodemailer');
const pify = require('pify');
const previewEmail = require('preview-email');

// promise version of `juice.juiceResources`
const juiceResources = (html, options) => {
  return new Promise((resolve, reject) => {
    juice.juiceResources(html, options, (err, html) => {
      if (err) return reject(err);
      resolve(html);
    });
  });
};

const env = (process.env.NODE_ENV || 'development').toLowerCase();
const stat = pify(fs.stat);
const readFile = pify(fs.readFile);

class Email {
  constructor(config = {}) {
    debug('config passed %O', config);
    console.log('config passed', config);

    // 2.x backwards compatible support
    if (config.juiceOptions) {
      config.juiceResources = config.juiceOptions;
      delete config.juiceOptions;
    }

    debug('config.juiceResources %O', config.juiceResources);
    console.log('config.juiceResources', config.juiceResources);

    if (config.disableJuice) {
      config.juice = false;
      delete config.disableJuice;
    }

    debug('config.juice %O', config.juice);
    console.log('config.juice', config.juice);

    if (config.render) {
      config.customRender = true;
    }

    debug('config.customRender %O', config.customRender);
    console.log('config.customRender', config.customRender);

    this.config = _.merge(
      {
        views: {
          // directory where email templates reside
          root: path.resolve('emails'),
          options: {
            // default file extension for template
            extension: 'pug',
            map: {
              hbs: 'handlebars',
              njk: 'nunjucks'
            },
            engineSource: consolidate
          },
          // locals to pass to templates for rendering
          locals: {
            // turn on caching for non-development environments
            cache: !['development', 'test'].includes(env),
            // pretty is automatically set to `false` for subject/text
            pretty: true
          }
        },
        // <https://nodemailer.com/message/>
        message: {},
        send: !['development', 'test'].includes(env),
        preview: env === 'development',
        // <https://github.com/ladjs/i18n>
        // set to an object to configure and enable it
        i18n: false,
        // pass a custom render function if necessary
        render: this.render.bind(this),
        customRender: false,
        // force text-only rendering of template (disregards template folder)
        textOnly: false,
        // <https://github.com/werk85/node-html-to-text>
        htmlToText: {
          ignoreImage: true
        },
        subjectPrefix: false,
        // <https://github.com/Automattic/juice>
        juice: true,
        juiceResources: {
          preserveImportant: true,
          webResources: {
            relativeTo: path.resolve('build'),
            images: false
          }
        },
        // pass a transport configuration object or a transport instance
        // (e.g. an instance is created via `nodemailer.createTransport`)
        // <https://nodemailer.com/transports/>
        transport: {},
        // last locale field name (also used by @ladjs/i18n)
        lastLocaleField: 'last_locale',
        getPath(type, template) {
          return path.join(template, type);
        }
      },
      config
    );

    debug('merged config %O', this.config);
    console.log('merged config', this.config);

    // override existing method
    this.render = this.config.render;

    debug('config.transport %O', this.config.transport);
    console.log('config.transport', this.config.transport);

    if (!_.isFunction(this.config.transport.sendMail))
      this.config.transport = nodemailer.createTransport(this.config.transport);

    debug('transport created');
    console.log('transport created');

    debug('transformed config %O', this.config);
    console.log('transformed config', this.config);

    this.juiceResources = this.juiceResources.bind(this);
    this.getTemplatePath = this.getTemplatePath.bind(this);
    this.templateExists = this.templateExists.bind(this);
    this.checkAndRender = this.checkAndRender.bind(this);
    this.render = this.render.bind(this);
    this.renderAll = this.renderAll.bind(this);
    this.send = this.send.bind(this);
  }

  // shorthand use of `juiceResources` with the config
  // (mainly for custom renders like from a database)
  juiceResources(html) {
    debug('Juicing resources for HTML');
    console.log('Juicing resources for HTML');
    return juiceResources(html, this.config.juiceResources);
  }

  // a simple helper function that gets the actual file path for the template
  async getTemplatePath(template) {
    try {
      debug('Getting template path for %s', template);
      console.log('Getting template path for', template);
      const [root, view] = path.isAbsolute(template)
        ? [path.dirname(template), path.basename(template)]
        : [this.config.views.root, template];
      const paths = await getPaths(
        root,
        view,
        this.config.views.options.extension
      );
      const filePath = path.resolve(root, paths.rel);
      debug('Template path resolved to %s', filePath);
      console.log('Template path resolved to', filePath);
      return { filePath, paths };
    } catch (err) {
      debug('getTemplatePath error: %O', err);
      console.log('getTemplatePath error:', err);
      throw err;
    }
  }

  // returns true or false if a template exists
  // (uses same look-up approach as `render` function)
  async templateExists(view) {
    try {
      debug('Checking if template exists for %s', view);
      console.log('Checking if template exists for', view);
      const { filePath } = await this.getTemplatePath(view);
      const stats = await stat(filePath);
      if (!stats.isFile()) throw new Error(`${filePath} was not a file`);
      debug('Template exists for %s', view);
      console.log('Template exists for', view);
      return true;
    } catch (err) {
      debug('templateExists error: %O', err);
      console.log('templateExists error:', err);
      return false;
    }
  }

  async checkAndRender(type, template, locals) {
    try {
      debug('Checking and rendering type %s for template %s', type, template);
      console.log(
        'Checking and rendering type',
        type,
        'for template',
        template
      );
      const str = this.config.getPath(type, template, locals);
      if (!this.config.customRender) {
        const exists = await this.templateExists(str);
        if (!exists) return;
      }

      debug('Rendering template %s with locals %O', str, locals);
      console.log('Rendering template', str, 'with locals', locals);
      return this.render(str, {
        ...locals,
        ...(type === 'html' ? {} : { pretty: false })
      });
    } catch (err) {
      debug('checkAndRender error: %O', err);
      console.log('checkAndRender error:', err);
      throw err;
    }
  }

  // promise version of consolidate's render
  // inspired by koa-views and re-uses the same config
  // <https://github.com/queckezz/koa-views>
  async render(view, locals = {}) {
    try {
      debug('Rendering view %s with locals %O', view, locals);
      console.log('Rendering view', view, 'with locals', locals);
      const { map, engineSource } = this.config.views.options;
      const { filePath, paths } = await this.getTemplatePath(view);
      if (paths.ext === 'html' && !map) {
        const res = await readFile(filePath, 'utf8');
        debug('Rendered HTML view %s', view);
        console.log('Rendered HTML view', view);
        return res;
      }

      const engineName = map && map[paths.ext] ? map[paths.ext] : paths.ext;
      const renderFn = engineSource[engineName];
      if (!engineName || !renderFn)
        throw new Error(
          `Engine not found for the ".${paths.ext}" file extension`
        );

      if (_.isObject(this.config.i18n)) {
        if (
          this.config.i18n.lastLocaleField &&
          this.config.lastLocaleField &&
          this.config.i18n.lastLocaleField !== this.config.lastLocaleField
        )
          throw new Error(
            `The 'lastLocaleField' (String) option for @ladjs/i18n and email-templates do not match, i18n value was ${this.config.i18n.lastLocaleField} and email-templates value was ${this.config.lastLocaleField}`
          );

        const i18n = new I18N({ ...this.config.i18n, register: locals });

        // support `locals.user.last_locale` (variable based name lastLocaleField)
        // (e.g. for <https://lad.js.org>)
        if (
          _.isObject(locals.user) &&
          _.isString(locals.user[this.config.lastLocaleField])
        )
          locals.locale = locals.user[this.config.lastLocaleField];

        if (_.isString(locals.locale)) i18n.setLocale(locals.locale);
      }

      const res = await pify(renderFn)(filePath, locals);
      debug('Rendered view %s with engine %s', view, engineName);
      console.log('Rendered view', view, 'with engine', engineName);
      // transform the html with juice using remote paths
      // google now supports media queries
      // https://developers.google.com/gmail/design/reference/supported_css
      if (!this.config.juice) return res;
      const html = await this.juiceResources(res);
      debug('Juiced HTML for view %s', view);
      console.log('Juiced HTML for view', view);
      return html;
    } catch (err) {
      debug('render error: %O', err);
      console.log('render error:', err);
      throw err;
    }
  }

  // eslint-disable-next-line complexity
  async renderAll(template, locals = {}, nodemailerMessage = {}) {
    try {
      debug('Rendering all parts of template %s', template);
      console.log('Rendering all parts of template', template);
      const message = { ...nodemailerMessage };

      if (template && (!message.subject || !message.html || !message.text)) {
        const [subject, html, text] = await Promise.all(
          ['subject', 'html', 'text'].map((type) =>
            this.checkAndRender(type, template, locals)
          )
        );

        if (subject && !message.subject) message.subject = subject;
        if (html && !message.html) message.html = html;
        if (text && !message.text) message.text = text;
      }

      if (message.subject && this.config.subjectPrefix)
        message.subject = this.config.subjectPrefix + message.subject;

      // trim subject
      if (message.subject) message.subject = message.subject.trim();

      if (this.config.htmlToText && message.html && !message.text)
        // we'd use nodemailer-html-to-text plugin
        // but we really don't need to support cid
        // <https://github.com/andris9/nodemailer-html-to-text>
        message.text = htmlToText.fromString(
          message.html,
          this.config.htmlToText
        );

      // if we only want a text-based version of the email
      if (this.config.textOnly) delete message.html;

      // if no subject, html, or text content exists then we should
      // throw an error that says at least one must be found
      // otherwise the email would be blank (defeats purpose of email-templates)
      if (
        (!is.string(message.subject) ||
          is.emptyStringOrWhitespace(message.subject)) &&
        (!is.string(message.text) ||
          is.emptyStringOrWhitespace(message.text)) &&
        (!is.string(message.html) ||
          is.emptyStringOrWhitespace(message.html)) &&
        _.isArray(message.attachments) &&
        _.isEmpty(message.attachments)
      )
        throw new Error(
          `No content was passed for subject, html, text, nor attachments message props. Check that the files for the template "${template}" exist.`
        );

      debug('Rendered all parts of template %s', template);
      console.log('Rendered all parts of template', template);
      return message;
    } catch (err) {
      debug('renderAll error: %O', err);
      console.log('renderAll error:', err);
      throw err;
    }
  }

  async send(options = {}) {
    try {
      debug('Sending email with options %O', options);
      console.log('Sending email with options', options);
      options = {
        template: '',
        message: {},
        locals: {},
        ...options
      };

      let { template, message, locals } = options;

      const attachments =
        message.attachments || this.config.message.attachments || [];

      message = _.defaultsDeep(
        {},
        _.omit(message, 'attachments'),
        _.omit(this.config.message, 'attachments')
      );
      locals = _.defaultsDeep({}, this.config.views.locals, locals);

      if (attachments) message.attachments = attachments;

      debug('template %s', template);
      console.log('template', template);
      debug('message %O', message);
      console.log('message', message);
      debug('locals (keys only): %O', Object.keys(locals));
      console.log('locals (keys only):', Object.keys(locals));

      // get all available templates
      const obj = await this.renderAll(template, locals, message);

      // assign the object variables over to the message
      Object.assign(message, obj);

      if (this.config.preview) {
        debug('using `preview-email` to preview email');
        console.log('using `preview-email` to preview email');
        if (_.isObject(this.config.preview))
          await previewEmail(message, this.config.preview);
        else await previewEmail(message);
      }

      if (!this.config.send) {
        debug('send disabled so we are ensuring JSONTransport');
        console.log('send disabled so we are ensuring JSONTransport');
        // <https://github.com/nodemailer/nodemailer/issues/798>
        // if (this.config.transport.name !== 'JSONTransport')
        this.config.transport = nodemailer.createTransport({
          jsonTransport: true
        });
      }

      const res = await this.config.transport.sendMail(message);
      debug('message sent');
      console.log('message sent');
      res.originalMessage = message;
      return res;
    } catch (err) {
      debug('send error: %O', err);
      console.log('send error:', err);
      throw err;
    }
  }
}

module.exports = Email;
