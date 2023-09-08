import nconf from 'nconf';
import validator from 'validator';
import { Request, Response, NextFunction } from 'express';

import * as plugins from '../plugins';
import * as meta from '../meta';
import * as translator from '../translator';
import * as widgets from '../widgets';
import * as utils from '../utils';
import * as helpers from '../helpers';

const relative_path : string = nconf.get('relative_path') as string;

type MiddleWare = {
    processRender : (req : Request, res : Response, next : NextFunction) => void
    admin? : {[key: string] : (req: Request, res: Response, options: Options) => Promise<string>};
}

type Options = {
    loggedIn? : boolean;
    relative_path? : string;
    template? : {[x: string]: string | boolean; name: string};
    url? : string;
    bodyClass? : string;
    _header? : { tags: any; };
    widgets? : any;
    _locals? : any;
    title? : string;
};

type Render = (tpl: string, options: Options, callback: (err: Error, str: string) => void) => void

const processRender = (middleware : MiddleWare) => {
    const porcessRender = function (req : Request, res : Response, next : NextFunction) : void {
        // res.render post-processing, modified from here: https://gist.github.com/mrlannigan/5051687
        const { render } = res;

        res.render = async function renderOverride(template : string, options? : object, fn? : (err: Error, html: string) => void) : Promise<void> {
            const self = this;
            const { req } = this;
            const renderMethod = async function (template : string, options? : Options, fn? : (err: Error, html: string) => void) {
                options = options || {};
                if (typeof options === 'function') {
                    fn = options as (err: Error, html: string) => void;
                    options = {};
                }

                options.loggedIn = req.uid > 0;
                options.relative_path = relative_path;
                options.template = { name: template, [template]: true };
                options.url = (req.baseUrl + req.path.replace(/^\/api/, ''));
                options.bodyClass = helpers.buildBodyClass(req, res, options);

                if (req.loggedIn) {
                    res.set('cache-control', 'private');
                }

                const buildResult = await plugins.hooks.fire(`filter:${template}.build`, { req: req, res: res, templateData: options });
                if (res.headersSent) {
                    return;
                }
                const templateToRender = buildResult.templateData.templateToRender || template;

                const renderResult = await plugins.hooks.fire('filter:middleware.render', { req: req, res: res, templateData: buildResult.templateData });
                if (res.headersSent) {
                    return;
                }
                options = renderResult.templateData;
                options._header = {
                    tags: await meta.tags.parse(req, renderResult, res.locals.metaTags, res.locals.linkTags),
                };
                options.widgets = await widgets.render(req.uid, {
                    template: `${template}.tpl`,
                    url: options.url,
                    templateData: options,
                    req: req,
                    res: res,
                });
                res.locals.template = template;
                options._locals = undefined;

                if (res.locals.isAPI) {
                    if (req.route && req.route.path === '/api/') {
                        options.title = '[[pages:home]]';
                    }
                    req.app.set('json spaces', global.env === 'development' || req.query.pretty ? 4 : 0);
                    return res.json(options);
                }
                const optionsString = JSON.stringify(options).replace(/<\//g, '<\\/');
                const results = await utils.promiseParallel({
                    header: renderHeaderFooter('renderHeader', req, res, options),
                    content: renderContent(render, templateToRender, req, res, options),
                    footer: renderHeaderFooter('renderFooter', req, res, options),
                });

                const str = `${results.header +
                    (res.locals.postHeader || '') +
                    results.content
                }<script id="ajaxify-data" type="application/json">${
                    optionsString
                }</script>${
                    res.locals.preFooter || ''
                }${results.footer}`;

                if (typeof fn !== 'function') {
                    self.send(str);
                } else {
                    fn(null, str);
                }
            }

            try {
                await renderMethod(template, options, fn);
            } catch (err) {
                next(err);
            }
        };

        next();
    };

    const translate = async function (str : string, language : string) : Promise<string> {
        const translated = await translator.translate(str, language);
        return translator.unescape(translated);
    }

    const getLang = function (req : Request, res : Response) : string {
        let language = (res.locals.config && res.locals.config.userLang) || 'en-GB';
        if (res.locals.renderAdminHeader) {
            language = (res.locals.config && res.locals.config.acpLang) || 'en-GB';
        }
        // The next line calls a function in a module that has not been updated to TS yet
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        return req.query.lang ? (validator as any).escape(String(req.query.lang)) : language;
    }

    const renderContent = async function renderContent(render : Render, tpl : string, req : Request, res : Response, options : Options) {
        return new Promise((resolve, reject) => {
            render.call(res, tpl, options, async (err : Error, str : string) => {
                if (err) reject(err);
                else resolve(await translate(str, getLang(req, res)));
            });
        });
    }

    const renderHeaderFooter = async function (method : string, req : Request, res : Response, options : Options) : Promise<string> {
        let str = '';
        if (res.locals.renderHeader) {
            str  = await middleware[method](req, res, options);
        } else if (res.locals.renderAdminHeader) {
            str = await middleware.admin[method](req, res, options);
        } else {
            str = '';
        }
        return await translate(str, getLang(req, res));
    }
};

export default processRender;
