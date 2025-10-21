// schedule.js（参考改造版）
const schedule = require('node-schedule');
const planModel = require('./models/plan');
const resultModel = require('./models/result');
const yapi = require('yapi.js');
const axios = require('axios');
const jobMap = new Map();
const retryMap = new Map();

class testSchedule {
    constructor(ctx) {
        this.ctx = ctx;
        this.planModel = yapi.getInst(planModel);
        this.resultModel = yapi.getInst(resultModel);
        this.init();
    }

    // 初始化定时任务
    async init() {
        let allPlan = await this.planModel.listAll();
        for (let i = 0, len = allPlan.length; i < len; i++) {
            let plan = allPlan[i];
            if (plan.is_plan_open) {
                this.addTestJob(plan._id, plan);
            }
        }
    }

    // 辅助：根据 plan 构造最终请求 url
    _buildUrl(plan, planId, trigger = 'schedule') {
        let url = plan.plan_url || '';

        // 统一参数模式
        url = url.replace("download=true", "download=false");
        url = url.replace("mode=html", "mode=json");
        url = url.replace(/&plan_id=\d+&/, "&");

        // 根据触发来源修改接口路径
        if (trigger === 'manual') {
            // 手动执行（run_once）走 plugin/test/run_once
            url = url.replace("/api/open/run_auto_test", "/api/open/plugin/test/run_once");
        } else {
            // 定时执行走 plugin/test/run
            url = url.replace("/api/open/run_auto_test", "/api/open/plugin/test/run");
        }

        // 确保带上 plan_id 参数
        if (url.indexOf('?') === -1) {
            url += '?plan_id=' + planId;
        } else {
            url += '&plan_id=' + planId;
        }
        return url;
    }

    /**
     * handlerPlan：核心执行逻辑（调用测试URL -> 保存结果 -> 清理历史 -> （可选）重试调度）
     * opts.allowRetryScheduling: 是否允许像定时任务那样通过 jobMap 取消/恢复/调度重试（手动触发时设为 false）
     * opts.trigger: 'schedule' | 'manual'
     */
    // 核心执行逻辑（支持手动/定时/重试）
    async handlerPlan(planId, plan, retry = 0, opts = { allowRetryScheduling: true, trigger: 'schedule' }) {
        const url = this._buildUrl(plan, planId, opts.trigger);

        try {
            const result = await axios.get(url);
            const data = result.data || { message: {} };

            // 写动态日志
            this.saveTestLog(plan.plan_name, data.message.msg, plan.uid, plan.project_id);

            // 保存执行结果
            const newResult = {
                plan_id: planId,
                project_id: plan.project_id,
                plan_name: plan.plan_name,
                uid: plan.uid,
                create_time: Date.now(),
                total: data.message.total || 0,
                successNum: data.message.successNum || 0,
                failedNum: data.message.failedNum || 0,
                message: data.message,
                trigger: opts.trigger || 'schedule'
            };

            const saved = await this.resultModel.save(newResult);

            // 控制结果记录数量
            if (plan.plan_result_size >= 0) {
                const results = await this.resultModel.findByPlan(planId);
                const ids = results.map(val => val._id).slice(plan.plan_result_size);
                if (ids && ids.length) {
                    await this.resultModel.deleteByIds(ids);
                }
            }

            // ===== 这里开始用 if / else 区分执行场景 =====
            if (opts.trigger === 'manual') {
                // 手动执行逻辑（run_once）
                yapi.commons.log(`计划【${plan.plan_name}】手动执行完成，成功 ${data.message.successNum}，失败 ${data.message.failedNum}`);
                // 不走重试逻辑
            } else if (opts.trigger === 'schedule' && opts.allowRetryScheduling) {
                // 定时任务逻辑
                const job = jobMap.get(planId);

                // 有失败则判断是否需要重试
                if (data.message.failedNum !== 0 && plan.plan_fail_retries && plan.plan_fail_retries > retry) {
                    job && job.cancel();

                    const retryDate = new Date();
                    retryDate.setSeconds(retryDate.getSeconds() + 60 * (retry + 1));

                    const retryItem = schedule.scheduleJob(retryDate, async () => {
                        yapi.commons.log(`项目ID为【${plan.project_id}】下计划【${plan.plan_name}】失败后自动重试第${retry + 1}次`);
                        this.deleteRetryJob(planId);
                        await this.handlerPlan(planId, plan, retry + 1, opts);
                    });

                    this.addRetryJob(planId, retryItem);
                } else if (retry > 0) {
                    // 重试结束，恢复定时任务
                    job && job.reschedule(plan.plan_cron);
                }
            }

            return saved;
        } catch (e) {
            yapi.commons.log(`项目ID为【${plan.project_id}】下测试计划【${plan.plan_name}】执行失败，错误：${e.message || e}`);
            throw e;
        }
    }

    /**
     * 添加一个测试计划（保持大部分原样）
     */
    async addTestJob(planId, plan) {
        // 注册定时任务：定时任务走 handlerPlan 并允许重试调度
        let scheduleItem = schedule.scheduleJob(plan.plan_cron, async () => {
            await this.handlerPlan(planId, plan, 0, { allowRetryScheduling: true, trigger: 'schedule' });
        });

        //判断是否已经存在这个任务
        let jobItem = jobMap.get(planId);
        if (jobItem) {
            jobItem.cancel();
        }
        jobMap.set(planId, scheduleItem);
    }

    // 对外提供一个手动执行入口（controller 可以调用）
    // 如果你有 plan 对象可传入，否则可以先从 planModel 里读取
    async runOnce(planId, planObj) {
        let plan = planObj;
        if (!plan) {
            // 请替换成实际获取单个 plan 的方法名（如 get / findById）
            plan = await this.planModel.get(planId);
        }
        if (!plan) {
            throw new Error('plan not found: ' + planId);
        }
        // 手动执行时禁止对定时任务的取消/重试调度（避免影响 schedule 中的 job）
        const saved = await this.handlerPlan(planId, plan, 0, { allowRetryScheduling: false, trigger: 'manual' });
        return saved;
    }

    getTestJob(planId) {
        return jobMap.get(planId);
    }

    deleteTestJob(planId) {
        let jobItem = jobMap.get(planId);
        if (jobItem) {
            jobItem.cancel();
        }
        this.deleteRetryJob(planId);
    }

    saveTestLog(plan, msg, uid, projectId) {
        yapi.commons.saveLog({
            content: `成功执行计划名为"${plan}"的自动化测试，${msg}。`,
            type: 'project',
            uid: uid,
            username: "自动化测试",
            typeid: projectId
        });
    }

    addRetryJob(planId, retryItem) {
        let jobItem = retryMap.get(planId);
        if (jobItem) {
            jobItem.cancel();
        }
        retryMap.set(planId, retryItem);
    }

    deleteRetryJob(planId) {
        let jobItem = retryMap.get(planId);
        if (jobItem) {
            jobItem.cancel();
        }
    }
}

module.exports = testSchedule;
