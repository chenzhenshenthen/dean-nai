"use client";

import { Dices, Lock, LockOpen } from "lucide-react";
import { useStore } from "@/lib/store";
import { isV5Model, NOISE_OPTIONS, SAMPLER_OPTIONS, UC_PRESET_OPTIONS } from "@/lib/nai/models";
import { Field, Section } from "./field";
import { Select } from "@/components/ui/select";
import { Input, NumberInput } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { SwitchRow } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { ReferenceUploader } from "./reference-uploader";
import { cn } from "@/lib/utils";

const MAX_SEED = 4294967295;

export function AdvancedTab() {
  const settings = useStore((state) => state.settings);
  const patch = useStore((state) => state.patchSettings);
  const lastSeed = useStore((state) => state.selectedImage?.seed);
  const isRandom = settings.seed < 0;
  const v5 = isV5Model(settings.model);

  return (
    <>
      <Section title="Sampling">
        <Field label="Seed">
          <div className="flex gap-2">
            <NumberInput
              min={0}
              max={MAX_SEED}
              disabled={isRandom}
              value={isRandom ? "" : settings.seed}
              placeholder={lastSeed !== undefined ? `random · last ${lastSeed}` : "random"}
              onChange={(event) => patch({ seed: Number(event.target.value) })}
              className="flex-1"
            />
            <Button
              variant="outline"
              size="icon"
              aria-label="Roll a new seed"
              title="Roll a new seed"
              onClick={() => patch({ seed: Math.floor(Math.random() * MAX_SEED) })}
            >
              <Dices className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label={isRandom ? "Seed is random — click to pin" : "Seed is pinned — click to randomize"}
              title={isRandom ? "Seed is random — click to pin" : "Seed is pinned — click to randomize"}
              className={cn(!isRandom && "border-accent text-accent")}
              onClick={() => patch({ seed: isRandom ? Math.floor(Math.random() * MAX_SEED) : -1 })}
            >
              {isRandom ? <LockOpen className="size-4" /> : <Lock className="size-4" />}
            </Button>
          </div>
        </Field>
        <Field>
          <Slider
            label="Batch size"
            min={1}
            max={8}
            value={settings.nSamples}
            onValueChange={(nSamples) => patch({ nSamples })}
            format={(value) => `${value} image${value > 1 ? "s" : ""}`}
          />
        </Field>
        <Field hint="More steps means finer detail and a slower run. 23–28 is typical.">
          <Slider label="Steps" showRange min={1} max={50} value={settings.steps} onValueChange={(steps) => patch({ steps })} />
        </Field>
        <Field label="Sampler" htmlFor="sampler">
          <Select id="sampler" value={settings.sampler} onChange={(event) => patch({ sampler: event.target.value as typeof settings.sampler })}>
            {SAMPLER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </Select>
        </Field>
      </Section>

      <Section title="Quality">
        <Field>
          <SwitchRow
            label="Quality tags"
            hint="Append model quality tags"
            checked={settings.qualityToggle}
            onCheckedChange={(qualityToggle) => patch({ qualityToggle })}
          />
        </Field>
        {v5 && settings.qualityToggle && (
          <Field label="V5 quality tier" htmlFor="v5-quality-tier" hint="Standard 使用 masterpiece；Light 使用 amazing quality。两档都包含 no text。">
            <Select id="v5-quality-tier" value={settings.qualityTier} onChange={(event) => patch({ qualityTier: event.target.value as "standard" | "light" })}>
              <option value="standard">Standard</option>
              <option value="light">Light</option>
            </Select>
          </Field>
        )}
        <Field label="Undesired content preset" htmlFor="ucpreset">
          <Select
            id="ucpreset"
            value={String(settings.ucPreset)}
            onChange={(event) => patch({ ucPreset: Number(event.target.value) as 0 | 1 | 2 | 3 })}
          >
            {UC_PRESET_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </Select>
        </Field>
      </Section>

{v5 && (
        <Section title="V5 rendering" description="V5 原生透明通道设置">
          <Field>
            <SwitchRow
              label="透明背景"
              hint="同时提交 transparent background 与官方透明背景提示。"
              checked={settings.transparentBackground}
              onCheckedChange={(transparentBackground) => patch({ transparentBackground })}
            />
          </Field>
          {settings.transparentBackground && (
            <Field>
              <SwitchRow
                label="Straight alpha"
                hint="开启时导出直通 Alpha；关闭时使用预乘 Alpha。"
                checked={settings.straightAlpha}
                onCheckedChange={(straightAlpha) => patch({ straightAlpha })}
              />
            </Field>
          )}
        </Section>
      )}

      <Section title="Guidance">
        <Field hint="Higher follows the prompt more literally and leaves less room for invention. 4–7 is typical.">
          <Slider label="Prompt guidance (CFG)" showRange min={1} max={10} step={0.1} value={settings.scale} onValueChange={(scale) => patch({ scale })} format={(value) => value.toFixed(1)} />
        </Field>
        <Field hint="Softens over-saturation at high guidance. Leave at 0 unless colours look burnt.">
          <Slider label="Guidance rescale" showRange min={0} max={1} step={0.01} value={settings.cfgRescale} onValueChange={(cfgRescale) => patch({ cfgRescale })} format={(value) => value.toFixed(2)} />
        </Field>
        <Field label="Noise schedule" htmlFor="noise">
          <Select id="noise" value={settings.noiseSchedule} onChange={(event) => patch({ noiseSchedule: event.target.value as typeof settings.noiseSchedule })}>
            {NOISE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </Select>
        </Field>
      </Section>

      <Section title="Options" description="Specialized sampling controls" collapsible defaultOpen={false}>
        <Field>
          <SwitchRow
            label="Dynamic thresholding"
            hint="Rescues detail lost to very high guidance. Usually off."
            checked={settings.dynamicThresholding}
            onCheckedChange={(dynamicThresholding) => patch({ dynamicThresholding })}
          />
        </Field>
        <Field>
          <SwitchRow
            label="Auto SMEA"
            hint="Improves coherence at large resolutions. Ignored on small sizes."
            checked={settings.autoSmea}
            onCheckedChange={(autoSmea) => patch({ autoSmea })}
          />
        </Field>
      </Section>

      {!v5 && <Section title="Vibe transfer" description={`${settings.vibe.length} reference${settings.vibe.length === 1 ? "" : "s"}`} collapsible defaultOpen={settings.vibe.length > 0}>
        <ReferenceUploader field="vibe" emptyLabel="Transfer the vibe of reference images." />
      </Section>}

      {!v5 && <Section
        title="Director / character reference"
        description={`${settings.directorReference.length} reference${settings.directorReference.length === 1 ? "" : "s"}`}
        collapsible
        defaultOpen={settings.directorReference.length > 0}
      >
        <ReferenceUploader field="directorReference" emptyLabel="Guide character features from a reference." />
      </Section>}
      {v5 && <Section title="V5 兼容说明"><p className="text-xs leading-5 text-muted">V5 已启用正式模型、流式生成、多角色、质量和负面预设。Vibe 与 Precise/Director Reference 当前不受 V5 支持，因此已隐藏。</p></Section>}
    </>
  );
}
