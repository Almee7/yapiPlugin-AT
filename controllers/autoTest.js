const yapi = require('yapi.js');
const schedule = require('../schedule'); // 你改造过的 schedule.js
const planModel = require('../models/plan');
const baseController = require('controllers/base.js');

class autoTestController extends baseController {
    constructor(ctx) {
        super(ctx);
        // 前端直接调用也可以执行，不用登录
        this.$auth = true;
    }
    /**
     * 手动执行一次计划
     * POST /api/plugin/test/run_once
     */
    async runOnce(ctx) {
        try {
            const planId = ctx.request.body.plan_id;
            if (!planId) {
                return ctx.body = yapi.commons.resReturn(null, 400, 'plan_id 必填');
            }

            const plan = await yapi.getInst(planModel).find(planId);
            if (!plan) {
                return ctx.body = yapi.commons.resReturn(null, 404, '未找到计划');
            }

            const testSchedule = new schedule(ctx);
            const saved = await testSchedule.runOnce(planId, plan);

            return ctx.body = yapi.commons.resReturn(saved, 0, '执行成功');
        } catch (e) {
            yapi.commons.log(`执行一次失败: ${e.message}`);
            return ctx.body = yapi.commons.resReturn(null, 500, e.message);
        }
    }
}

module.exports = autoTestController;
