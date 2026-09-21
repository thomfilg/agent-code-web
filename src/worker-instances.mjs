export const WORKER_INSTANCE_CATALOG = Object.freeze([
  { id: "t3.medium", vcpu: 2, memoryGiB: 4, usdPerHour: 0.0416, burstable: true },
  { id: "t3.large", vcpu: 2, memoryGiB: 8, usdPerHour: 0.0832, burstable: true },
  { id: "t3.xlarge", vcpu: 4, memoryGiB: 16, usdPerHour: 0.1664, burstable: true },
  { id: "t3.2xlarge", vcpu: 8, memoryGiB: 32, usdPerHour: 0.3328, burstable: true },
  { id: "m7i.large", vcpu: 2, memoryGiB: 8, usdPerHour: 0.1008, burstable: false },
  { id: "m7i.xlarge", vcpu: 4, memoryGiB: 16, usdPerHour: 0.2016, burstable: false, recommended: true },
  { id: "m7i.2xlarge", vcpu: 8, memoryGiB: 32, usdPerHour: 0.4032, burstable: false },
]);

// Current On-Demand Linux prices. The deployed stack uses this region; callers
// in another region must label these as reference prices rather than local ones.
export const WORKER_INSTANCE_PRICING_REGION = "us-east-2";

export function validateWorkerInstanceType(value, fallback = "t3.medium") {
  const selected = value || fallback;
  if (!WORKER_INSTANCE_CATALOG.some(instance => instance.id === selected)) throw new Error("Choose a supported worker machine size");
  return selected;
}
