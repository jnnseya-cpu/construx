/**
 * A small IFC4 model written by hand: a project, a site, a building with two
 * storeys, three walls, a slab and a column, each with a placement and an
 * extruded-solid representation, one property set, one space, and the
 * containment relationships that put the elements on their storeys.
 *
 * Every variation a revision comparison has to recognise is a switch: move a
 * wall (its placement changes, nothing else), rename one (name changes, geometry
 * does not), drop the slab, add a beam, or renumber every instance (the same
 * model exported again — nothing has changed).
 */
export function sampleIfc(
  options: {
    moveWall?: boolean;
    renameWall?: boolean;
    dropSlab?: boolean;
    addBeam?: boolean;
    /** Add this to every instance number, as a re-export does. */
    renumber?: number;
    unit?: 'MILLI' | 'METRE';
  } = {},
): Buffer {
  const shift = options.renumber ?? 0;
  const n = (id: number): string => `#${id + shift}`;
  const wallOneOrigin = options.moveWall ? '(1500.,0.,0.)' : '(0.,0.,0.)';
  const wallOneName = options.renameWall ? 'W-01 renamed' : 'W-01';
  const lengthUnit = options.unit === 'METRE' ? `${n(3)}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);` : `${n(3)}=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);`;

  const lines = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');",
    "FILE_NAME('inlet-works-arch.ifc','2026-08-30T10:15:00',('J Okafor'),('Meridian Design'),'IFC exporter 2.4','Archicad 27','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    `${n(1)}=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'Inlet works',$,$,$,$,(${n(20)}),${n(2)});`,
    `${n(2)}=IFCUNITASSIGNMENT((${n(3)}));`,
    lengthUnit,
    `${n(4)}=IFCSITE('2O2Fr$t4X7Zf8NOew3FLKI',$,'Ashworth WTW',$,$,${n(30)},$,$,.ELEMENT.,$,$,$,$,$);`,
    `${n(5)}=IFCBUILDING('2O2Fr$t4X7Zf8NOew3FLKJ',$,'Inlet building',$,$,${n(31)},$,$,.ELEMENT.,$,$,$);`,
    `${n(6)}=IFCBUILDINGSTOREY('2O2Fr$t4X7Zf8NOew3FLKK',$,'Ground floor',$,$,${n(32)},$,$,.ELEMENT.,0.);`,
    `${n(7)}=IFCBUILDINGSTOREY('2O2Fr$t4X7Zf8NOew3FLKL',$,'First floor',$,$,${n(33)},$,$,.ELEMENT.,3600.);`,
    // Geometric context, placements.
    `${n(20)}=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${n(21)},$);`,
    `${n(21)}=IFCAXIS2PLACEMENT3D(${n(22)},$,$);`,
    `${n(22)}=IFCCARTESIANPOINT((0.,0.,0.));`,
    `${n(30)}=IFCLOCALPLACEMENT($,${n(21)});`,
    `${n(31)}=IFCLOCALPLACEMENT(${n(30)},${n(21)});`,
    `${n(32)}=IFCLOCALPLACEMENT(${n(31)},${n(21)});`,
    `${n(33)}=IFCLOCALPLACEMENT(${n(31)},${n(34)});`,
    `${n(34)}=IFCAXIS2PLACEMENT3D(${n(35)},$,$);`,
    `${n(35)}=IFCCARTESIANPOINT((0.,0.,3600.));`,
    // Wall W-01: its own placement point, so moving it changes only #41.
    `${n(40)}=IFCLOCALPLACEMENT(${n(32)},${n(41)});`,
    `${n(41)}=IFCAXIS2PLACEMENT3D(${n(42)},$,$);`,
    `${n(42)}=IFCCARTESIANPOINT(${wallOneOrigin});`,
    `${n(43)}=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,5000.,200.);`,
    `${n(44)}=IFCEXTRUDEDAREASOLID(${n(43)},${n(21)},${n(45)},3000.);`,
    `${n(45)}=IFCDIRECTION((0.,0.,1.));`,
    `${n(46)}=IFCSHAPEREPRESENTATION(${n(20)},'Body','SweptSolid',(${n(44)}));`,
    `${n(47)}=IFCPRODUCTDEFINITIONSHAPE($,$,(${n(46)}));`,
    `${n(48)}=IFCWALL('1a2b3c4d5e6f7g8h9i0j1k',$,'${wallOneName}',$,$,${n(40)},${n(47)},$,.SOLIDWALL.);`,
    // Wall W-02 and W-03 share the profile and solid; distinct placements.
    `${n(50)}=IFCLOCALPLACEMENT(${n(32)},${n(51)});`,
    `${n(51)}=IFCAXIS2PLACEMENT3D(${n(52)},$,$);`,
    `${n(52)}=IFCCARTESIANPOINT((0.,6000.,0.));`,
    `${n(53)}=IFCWALL('1a2b3c4d5e6f7g8h9i0j2k',$,'W-02',$,$,${n(50)},${n(47)},$,.SOLIDWALL.);`,
    `${n(54)}=IFCLOCALPLACEMENT(${n(33)},${n(51)});`,
    `${n(55)}=IFCWALLSTANDARDCASE('1a2b3c4d5e6f7g8h9i0j3k',$,'W-03',$,$,${n(54)},${n(47)},$,.SOLIDWALL.);`,
    // Slab and column.
    ...(options.dropSlab
      ? []
      : [
          `${n(60)}=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,12000.,8000.);`,
          `${n(61)}=IFCEXTRUDEDAREASOLID(${n(60)},${n(21)},${n(45)},250.);`,
          `${n(62)}=IFCSHAPEREPRESENTATION(${n(20)},'Body','SweptSolid',(${n(61)}));`,
          `${n(63)}=IFCPRODUCTDEFINITIONSHAPE($,$,(${n(62)}));`,
          `${n(64)}=IFCSLAB('1a2b3c4d5e6f7g8h9i0j4k',$,'S-01',$,$,${n(32)},${n(63)},$,.FLOOR.);`,
        ]),
    `${n(70)}=IFCCIRCLEPROFILEDEF(.AREA.,$,$,200.);`,
    `${n(71)}=IFCEXTRUDEDAREASOLID(${n(70)},${n(21)},${n(45)},3600.);`,
    `${n(72)}=IFCSHAPEREPRESENTATION(${n(20)},'Body','SweptSolid',(${n(71)}));`,
    `${n(73)}=IFCPRODUCTDEFINITIONSHAPE($,$,(${n(72)}));`,
    `${n(74)}=IFCCOLUMN('1a2b3c4d5e6f7g8h9i0j5k',$,'C-01',$,$,${n(32)},${n(73)},$,.COLUMN.);`,
    ...(options.addBeam
      ? [
          `${n(80)}=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,300.,600.);`,
          `${n(81)}=IFCEXTRUDEDAREASOLID(${n(80)},${n(21)},${n(45)},6000.);`,
          `${n(82)}=IFCSHAPEREPRESENTATION(${n(20)},'Body','SweptSolid',(${n(81)}));`,
          `${n(83)}=IFCPRODUCTDEFINITIONSHAPE($,$,(${n(82)}));`,
          `${n(84)}=IFCBEAM('1a2b3c4d5e6f7g8h9i0j6k',$,'B-01',$,$,${n(33)},${n(83)},$,.BEAM.);`,
        ]
      : []),
    // A space, an opening (neither is an element), a property set, a wall type.
    `${n(90)}=IFCSPACE('1a2b3c4d5e6f7g8h9i0j7k',$,'Pump hall',$,$,${n(32)},$,$,.ELEMENT.,.INTERNAL.,$);`,
    `${n(91)}=IFCOPENINGELEMENT('1a2b3c4d5e6f7g8h9i0j8k',$,'Door opening',$,$,${n(40)},$,$,.OPENING.);`,
    `${n(92)}=IFCPROPERTYSET('1a2b3c4d5e6f7g8h9i0j9k',$,'Pset_WallCommon',$,(${n(93)}));`,
    `${n(93)}=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);`,
    `${n(94)}=IFCWALLTYPE('1a2b3c4d5e6f7g8h9i0jak',$,'Blockwork 200',$,$,$,$,$,$,.SOLIDWALL.);`,
    // Containment: ground floor holds W-01, W-02, the slab and the column; first floor holds W-03 and the beam.
    `${n(95)}=IFCRELCONTAINEDINSPATIALSTRUCTURE('1a2b3c4d5e6f7g8h9i0jbk',$,$,$,(${n(48)},${n(53)}${options.dropSlab ? '' : `,${n(64)}`},${n(74)}),${n(6)});`,
    `${n(96)}=IFCRELCONTAINEDINSPATIALSTRUCTURE('1a2b3c4d5e6f7g8h9i0jck',$,$,$,(${n(55)}${options.addBeam ? `,${n(84)}` : ''}),${n(7)});`,
    'ENDSEC;',
    'END-ISO-10303-21;',
  ];
  return Buffer.from(lines.join('\n'), 'latin1');
}
