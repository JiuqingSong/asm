import { checkpointErrors, type Experiment, type TeachingMachine } from './contracts.ts';

export function checkExperiment(machine: TeachingMachine, experiment: Experiment): void {
  const require = (condition: boolean, message: string) => {
    if (!condition) throw new Error(`${experiment.id}：${message}`);
  };
  machine.load(experiment.bytes);
  const maximum = Math.max(...experiment.checkpoints.map(c => c.step), experiment.fault?.step ?? 0);
  for (let step = 1; step <= maximum; step++) {
    if (experiment.fault?.step === step) {
      let fault: Error | null = null;
      try { machine.step(); } catch (error) {
        if (!(error instanceof Error)) throw error;
        fault = error;
      }
      require(fault !== null && fault.message.includes(experiment.fault.contains), '没有产生指定的教学错误');
      require(machine.state().ip === experiment.fault.ip, '错误时 IP 不在预期位置');
      require(machine.state().status === 'error', '错误未显示在机器状态中');
    } else {
      require(machine.step() !== null, '在检查点之前已经停机');
      for (const checkpoint of experiment.checkpoints.filter(c => c.step === step)) {
        const errors = checkpointErrors(machine.state(), checkpoint);
        require(errors.length === 0, `第 ${step} 步：${errors.join('；')}`);
      }
    }
  }
  if (!experiment.fault) {
    require(machine.state().status === 'halted', '程序没有进入停机状态');
    const halted = machine.state();
    require(machine.step() === null, '停机后仍执行了指令');
    require(JSON.stringify(machine.state()) === JSON.stringify(halted), '停机后状态改变');
  }
}
