import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { command, toAppError } from '../../platform/backend';
import { sameJson } from '../../platform/offline';
import { formatMoneyShort } from '../../platform/money';
import { useLocale } from '../../platform/locale';
import { Button, Card, ConfirmDialog, DataState, Field, Input, MoneyInput, Select } from '../../ui';
import { CustomPayFields, currencySymbol, customPayDraft, percentToBp, tierPolicy, validPolicyMoney } from './CustomPayFields';
import { pctBp } from './api';
import type { ShiftPolicy } from './Motivation';

export type NamedPay = ShiftPolicy & {name:string};
export type PayScheme = { id:string; version:number; active:boolean; policy:NamedPay };

export function usePaySchemes(partner:string, enabled=true) {
  return useQuery({queryKey:['pay-schemes',partner],enabled,queryFn:()=>command<PayScheme[]>('pay_scheme_list',{partner})});
}

export function usePayDraft(initial?:ShiftPolicy) {
  const fixed = initial && 'mode' in initial ? initial : null;
  const [mode,setMode] = useState<'fixed'|'tiers'>(fixed?'fixed':'tiers');
  const [tiers,setTiers] = useState(()=>customPayDraft(initial && 'tiers' in initial ? initial : undefined));
  const [fee,setFee] = useState(String(fixed?.fee_minor ?? 0));
  const [valid,setValid] = useState(true);
  const [rate,setRate] = useState(String((fixed?.rate_bp ?? 0)/100));
  const bp=percentToBp(rate);
  const validFee = validPolicyMoney({ minor: fee, valid });
  const policy:ShiftPolicy|null = mode==='tiers' ? tierPolicy(tiers) :
    validFee && bp!==null ? { mode:'legacy',rate_bp:bp,fee_minor:Number(fee) } : null;
  return { mode,setMode,tiers,setTiers,fee,setFee,validFee,setValid,rate,setRate,bp,policy };
}

export function PayDraftFields({draft,currency}:{draft:ReturnType<typeof usePayDraft>;currency:string}) {
  const {t}=useLocale();
  return <>
    <Field label={t('Способ расчёта','Hesaplama yöntemi')}
      help={t('Фикс прибавляется к проценту. Для ступеней действует большая сумма из гарантии и процента, затем прибавляется премия.',
        'Sabit ücret yüzdeye eklenir. Kademeli planda garanti ile yüzde tutarından yüksek olanına prim eklenir.')}>{id=>
      <Select id={id} value={draft.mode} onChange={e=>draft.setMode(e.target.value==='fixed'?'fixed':'tiers')}>
        <option value="tiers">{t('По ступеням выручки','Ciro kademelerine göre')}</option>
        <option value="fixed">{t('Фикс + процент','Sabit ücret + yüzde')}</option>
      </Select>}</Field>
    {draft.mode==='tiers' ? <CustomPayFields named={false} currency={currency} draft={draft.tiers} setDraft={draft.setTiers} />
      : <div className="pay-field-grid">
        <Field label={t('Ставка за выход','Vardiya ücreti')+', '+currencySymbol(currency)}
          help={t('Начисляется один раз за рабочий день сотрудника.','Çalışanın her iş günü için bir kez hesaplanır.')}
          error={draft.validFee ? undefined : t('Проверьте сумму','Tutarı kontrol edin')}>{(id,help)=>
          <MoneyInput id={id} currency={currency} value={draft.fee} onChange={draft.setFee} onValidityChange={draft.setValid}
            invalid={!draft.validFee} describedBy={help} />}</Field>
        <Field label={t('Доля выручки, %','Ciro payı, %')}
          help={t('Процент от выручки этой смены прибавляется к ставке.','Bu vardiyanın ciro yüzdesi sabit ücrete eklenir.')}
          error={draft.bp===null ? t('Введите процент от 0 до 100','0 ile 100 arasında bir yüzde girin') : undefined}>{(id,help)=>
          <Input id={id} inputMode="decimal" aria-describedby={help} value={draft.rate} onChange={e=>draft.setRate(e.target.value)} />}</Field>
      </div>}
  </>;
}

export function SchemeEditor({partner,scheme,currency,initial,onClose}:{partner:string;scheme?:PayScheme;currency:string;initial:ShiftPolicy;onClose:()=>void}) {
  const {t}=useLocale();const qc=useQueryClient();
  const [name,setName]=useState(scheme?.policy.name ?? initial.name ?? '');
  const [active,setActive]=useState(scheme?.active ?? true);
  const draft=usePayDraft(scheme?.policy ?? initial);
  const policy={...draft.policy,name:name.trim()};
  const save=useMutation({mutationFn:()=>command('pay_scheme_save',{partner,scheme:scheme?.id ?? null,expected_version:scheme?.version ?? 0,
    policy,active}),onSuccess:async()=>{await qc.invalidateQueries({queryKey:['pay-schemes',partner]});onClose();},
    onError:error=>{if(toAppError(error).code==='version-conflict')void qc.invalidateQueries({queryKey:['pay-schemes',partner]});}});
  const original=scheme?.policy ?? initial;
  const originalFormula={...original};delete originalFormula.name;
  const dirty=name!==(scheme?.policy.name ?? initial.name ?? '') || active!==(scheme?.active ?? true)
    || !draft.policy || !sameJson(draft.policy,originalFormula);
  return <ConfirmDialog open title={scheme?t('Изменить схему','Planı düzenle'):t('Новая схема','Yeni plan')} dirty={dirty}
    cancelLabel={t('Отмена','İptal')} confirmLabel={t('Сохранить схему','Planı kaydet')} onClose={onClose}
    disabled={!name.trim() || !draft.policy} busy={save.isPending} onConfirm={()=>save.mutate()} error={save.error}>
    <div className="pay-settings"><div className="pay-layout">
      <Field label={t('Название схемы','Plan adı')} required help={t('Это название будет видно в списке и у сотрудников, которым назначена схема.','Bu ad listede ve planın atandığı çalışanın kartında görünür.')}>{id=>
        <Input id={id} maxLength={100} value={name} onChange={e=>setName(e.target.value)} />}</Field>
      <PayDraftFields draft={draft} currency={currency}/>
      {scheme && <Field label={t('Доступность схемы','Plan durumu')} help={t('Архивная схема сохраняется у тех, кому её уже назначили.','Arşivlenen plan mevcut atamalarda geçerli kalır.')}>{id=>
        <Select id={id} value={active?'on':'off'} onChange={e=>setActive(e.target.value==='on')}>
          <option value="on">{t('Доступна для выбора','Seçilebilir')}</option><option value="off">{t('В архиве','Arşivde')}</option>
        </Select>}</Field>}
    </div></div>
  </ConfirmDialog>;
}

function SetDefault({partner,scheme,version,today,onClose}:{partner:string;scheme:PayScheme;version:number;today?:string;onClose:()=>void}) {
  const {t}=useLocale();const qc=useQueryClient();
  const [initialVersion]=useState(version);
  const [date,setDate]=useState(today ?? '');
  const save=useMutation({mutationFn:()=>command('pay_scheme_apply',{partner,scheme:scheme.id,scheme_version:scheme.version,user:null,
    expected_version:initialVersion,effective_from:date || null,internship_floor_minor:null}),
    onError:error=>{if(toAppError(error).code==='version-conflict'){void qc.invalidateQueries({queryKey:['motivation',partner]});void qc.invalidateQueries({queryKey:['pay-schemes',partner]});}},
    onSuccess:async()=>{await Promise.all([qc.invalidateQueries({queryKey:['motivation',partner]}),qc.invalidateQueries({queryKey:['staff']}),qc.invalidateQueries({queryKey:['staff-list',partner]})]);onClose();}});
  return <ConfirmDialog open title={t('Назначить по умолчанию','Varsayılan planı ayarla')} confirmLabel={t('Назначить','Uygula')}
    cancelLabel={t('Отмена','İptal')} onClose={onClose} onConfirm={()=>save.mutate()} busy={save.isPending} error={save.error}>
    <p><strong>{scheme.policy.name}</strong></p>
    <p>{t('Эти условия будут действовать для сотрудников на общей схеме с выбранной даты.','Bu koşullar, seçilen tarihten itibaren ortak planı kullanan çalışanlara uygulanır.')}</p>
    <Field label={t('Действует с','Başlangıç tarihi')} help={t('Учитывается дата смены по местному времени точки.','Şubenin yerel saatine göre vardiya tarihi esas alınır.')}>{id=>
      <Input id={id} type="date" value={date} onChange={e=>setDate(e.target.value)}/>}</Field>
  </ConfirmDialog>;
}

export function PayCatalogue({partner,currency,version,today,policy}:{partner:string;currency:string;version:number;today?:string;policy:ShiftPolicy}) {
  const {t,locale}=useLocale();const schemes=usePaySchemes(partner);
  const [editing,setEditing]=useState<PayScheme|'new'|null>(null);
  const [assigning,setAssigning]=useState<PayScheme|null>(null);
  return <Card title={t('Схемы оплаты','Ücret planları')} className="pay-settings">
    <div className="pay-layout">
      <Button size="sm" onClick={()=>setEditing('new')}>{t('Создать схему','Plan oluştur')}</Button>
      <DataState query={schemes}>{list=>list.length ? <ul className="list">
        {list.map(s=><li key={s.id} className="pay-scheme-item">
          <div><strong>{s.policy.name}</strong>{!s.active && <span className="faint"> · {t('В архиве','Arşivde')}</span>}
            <div className="faint">{'mode' in s.policy
              ? formatMoneyShort(s.policy.fee_minor,currency,locale)+' + '+pctBp(s.policy.rate_bp)
              : t('Гарантия','Garanti')+' '+formatMoneyShort(s.policy.floor_minor,currency,locale)+' · '+t('ступеней','kademe')+' '+s.policy.tiers.length}</div></div>
          <div className="row"><Button size="sm" onClick={()=>setEditing(s)}>{t('Изменить схему','Planı düzenle')}</Button>
            {s.active && <Button size="sm" onClick={()=>setAssigning(s)}>{t('Назначить по умолчанию','Varsayılan yap')}</Button>}</div>
        </li>)}</ul> : <p className="pay-help">{t('Сохранённых схем пока нет.','Henüz kayıtlı plan yok.')}</p>}</DataState>
      {editing && <SchemeEditor partner={partner} scheme={editing==='new'?undefined:editing} initial={{...policy,name:undefined}} currency={currency} onClose={()=>setEditing(null)}/>}
      {assigning && <SetDefault partner={partner} scheme={assigning} version={version} today={today} onClose={()=>setAssigning(null)}/>}
    </div>
  </Card>;
}
