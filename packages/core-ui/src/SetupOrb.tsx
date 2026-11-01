import { Orb } from './orb-rendering/orb';

/** Original upstream Vessel renderer; setup animation does not use audio input. */
export function SetupOrb({ large = false, active = false }: { large?: boolean; active?: boolean }) {
  return <div className={`setup-orb${large ? ' setup-orb-large' : ''}`} aria-hidden="true">
    <Orb finish="vessel" palette="spectrum" field="dark" state="idle" outputLevelRef={active ? 1 : 0.4} inputLevelRef={0} speed={active ? 0.65 : 0.3} pointerReactive={false} style={{ width: '100%', height: '100%' }}/>
  </div>;
}
